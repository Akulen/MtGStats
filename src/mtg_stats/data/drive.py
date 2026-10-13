from dataclasses import dataclass
import time
from typing import Callable, List, TypeVar

from google.oauth2 import service_account
from googleapiclient.discovery import build as gobuild
from googleapiclient.errors import HttpError

@dataclass
class DriveFile:
    id: str
    name: str
    mime_type: str
    modified_time: str
    folder_path: str

SPREADSHEET_MIME = 'application/vnd.google-apps.spreadsheet'
FOLDER_MIME = 'application/vnd.google-apps.folder'
SHORTCUT_MIME = 'application/vnd.google-apps.shortcut'

QUOTAS = { #requests/min
    'sheet': 60
}

T = TypeVar('T')
U = TypeVar('U')

class Drive:
    def __init__(self, credentials_path: str, logger=None):
        self.logger = logger
        creds = service_account.Credentials.from_service_account_file(
            credentials_path,
            scopes=[
                'https://www.googleapis.com/auth/drive.readonly',
                'https://www.googleapis.com/auth/spreadsheets.readonly',
            ]
        )
        self.drive = gobuild(
            'drive', 'v3', credentials=creds, cache_discovery=False
        )
        self.requests = {}
        self.sheets = gobuild(
            'sheets', 'v4', credentials=creds, cache_discovery=False
        )

    def wait_quota(self, tp: str):
        if tp not in self.requests:
            self.requests[tp] = []
            return
        quota = 1
        if tp in QUOTAS:
            quota = max(1, QUOTAS[tp])
        elif self.logger:
            self.logger.info(
                f'Quotas for {tp} were not set, using a safe default of 1/m'
            )
        safe_time = time.time()
        while len(self.requests[tp]) >= quota:
            safe_time = self.requests[tp].pop(0) + 65
        to_sleep = safe_time - time.time()
        if to_sleep > 0:
            time.sleep(to_sleep)

    def use_quota(self, tp: str):
        if tp not in self.requests:
            self.requests[tp] = []
        self.requests[tp].append(time.time())

    def safe_query(
        self, fun:Callable[[], T], default:U=None, retries: int=5,
        quota_type: str | None=None, exp_base=2
    ) -> T | U:
        for attempt in range(retries):
            try:
                if quota_type:
                    self.wait_quota(quota_type)
                r = fun()
                if quota_type:
                    self.use_quota(quota_type)
                return r
            except HttpError as e:
                if attempt == retries - 1:
                    raise e
                time.sleep(exp_base ** attempt)
        return default

    def list_children(self, folder_id: str, retries: int=5):
        page_token = None
        while True:
            resp = self.safe_query(
                lambda: self.drive.files().list(
                    q=f"'{folder_id}' in parents and trashed = false",
                    fields='nextPageToken, files('
                           '  id, name, mimeType, modifiedTime, '
                           '  shortcutDetails(targetId, targetMimeType)'
                           ')',
                    pageSize=200,
                    pageToken=page_token,
                    supportsAllDrives=True,
                    includeItemsFromAllDrives=True,
                ).execute(),
                default={}, retries=retries
            )
            for f in resp.get('files', []):
                if f['mimeType'] == SHORTCUT_MIME:
                    target = f.get('shortcutDetails', {})
                    f = {
                        **f,
                        'id': target['targetId'],
                        'mimeType': target.get('targetMimeType')
                    }
                yield f
            page_token = resp.get('nextPageToken')
            if not page_token:
                return

    def walk_tree(self, root_folder_id: str, filter=None):
        to_walk = [(root_folder_id, '')]
        while to_walk:
            folder_id, path = to_walk.pop()
            for f in self.list_children(folder_id):
                if filter is not None and not filter(path, f['name']):
                    continue
                if f['mimeType'] == FOLDER_MIME:
                    to_walk.append((f['id'], f'{path}/{f['name']}'))
                else:
                    yield DriveFile(
                        id=f['id'],
                        name=f['name'],
                        mime_type=f['mimeType'],
                        modified_time=f['modifiedTime'],
                        folder_path=path,
                    )

    def get_sheet_tab_names(self, sheet_id: str, retries: int=5) -> List[str]:
        def foo():
            meta = self.sheets.spreadsheets().get(
                spreadsheetId=sheet_id,
                fields="sheets(properties(title))",
            ).execute()
            return [
                s["properties"]["title"] for s in meta.get("sheets", [])
            ]
        return self.safe_query(
            foo, default=[], quota_type='sheet', retries=retries
        )

    def get_sheet_values(self, sheet_id: str, tab_name: str, retries: int=5):
        def foo():
            resp = self.sheets.spreadsheets().values().get(
                    spreadsheetId=sheet_id,
                    range=f"'{tab_name}'",
                    valueRenderOption='UNFORMATTED_VALUE'
            ).execute()
            return resp.get('values', [])
        return self.safe_query(
            foo, default=[], quota_type='sheet', retries=retries
        )

    def get_sheet_tabs(
        self, sheet_id: str, tab_names: List[str], retries: int=5
    ):
        def foo():
            resp = self.sheets.spreadsheets().values().batchGet(
                    spreadsheetId=sheet_id,
                    ranges=[f"'{tab_name}'" for tab_name in tab_names],
                    valueRenderOption='UNFORMATTED_VALUE'
            ).execute()
            return [
                tab.get('values', [])
                for tab in resp.get('valueRanges', {})
            ]
        return self.safe_query(
            foo, default=[], quota_type='sheet', retries=retries
        )

    def get_sheet(
        self, sheet_id: str, tab_filter: List[str] | None, retries: int=5
    ):
        tabs = [
            tab
            for tab in self.get_sheet_tab_names(sheet_id, retries)
            if tab_filter is None or tab in tab_filter
        ]
        values = self.get_sheet_tabs(sheet_id, tabs, retries)
        return {
            tab: data
            for tab, data in zip(tabs, values)
        }
