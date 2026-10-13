import gzip
import json
import time
from pathlib import Path

# stores data that can be converted to JSON
class Store:
    def __init__(self, data_dir: str):
        self.root = Path(data_dir)
        self.manifest_path = self.root / 'manifest.json'
        self.manifest = self._load_manifest()

    def _load_manifest(self):
        if self.manifest_path.exists():
            return json.loads(self.manifest_path.read_text())
        return {}

    def save_manifest(self):
        self.manifest_path.write_text(
            json.dumps(self.manifest, indent=2, sort_keys=True)
        )

    def needs_processing(self, file_id: str, modified_time: str):
        entry = self.manifest.get(file_id)
        return entry is None or entry.get('modified_time') != modified_time

    def get_filename(self, file_id: str):
        out_dir = self.root / 'files'
        out_dir.mkdir(parents=True, exist_ok=True)
        return out_dir / f'{file_id}.json.gz'

    def write(self, file_id: str, data: dict, modified_time=None):
        filename = self.get_filename(file_id)
        with gzip.open(filename, 'wt', encoding='UTF-8') as f:
            json.dump(data, f)
        if not modified_time:
            modified_time = time.time()
        self.manifest[file_id] = {
            'modified_time': modified_time
        }

    def load(self, file_id: str):
        filename = self.get_filename(file_id)
        with gzip.open(filename, 'rt', encoding='UTF-8') as f:
            return json.load(f)
