"""
Utilities to crawl the Legacy Data Collection Project Google Drive, and collect
the raw data
"""

import datetime
import gzip
import json
import logging
import re
import time

from googleapiclient.errors import HttpError

from .drive import Drive, DriveFile, SPREADSHEET_MIME
from .store import Store

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s %(levelname)s %(message)s',
)
log = logging.getLogger('collect')

DATE_RE = re.compile(r'(\d{1,2})/(\d{1,2})/(\d{4})')
ALT_DATE_RE = re.compile(r'(\d{1,2})/(\d{1,2})')
FOLDER_DATE_RE = re.compile(r'/(\d{4})/(\d{1,2}) ?- [A-Z][a-z][a-z]+')

def parse_metadata(f: DriveFile):
    name_year = name_month = name_day = None
    m = DATE_RE.search(f.name)
    if m: # urgh... american date format
        name_month, name_day, name_year = map(int, m.groups())
    else:
        m = ALT_DATE_RE.search(f.name)
        if m:
            name_month, name_day = map(int, m.groups())

    folder_year, folder_month = None, None
    m = FOLDER_DATE_RE.search(f.folder_path)
    if m:
        folder_year, folder_month = map(int, m.groups())
    if folder_year != name_year:
        log.warning(
            f"Filename year ({name_year}) doesn't match folder year "
            f"({folder_year})"
        )
    if folder_month != name_month:
        log.warning(
            f"Filename month ({name_month}) doesn't match folder month "
            f"({folder_month})"
        )

    year = folder_year
    month = folder_month
    day = name_day
    if not(year and month and day):
        raise Exception(f"Couldn't parse the date ({year}/{month}/{day})")

    date = datetime.date(year, month, day)
    if date > datetime.datetime.fromisoformat(f.modified_time).date():
        raise Exception(
            f'Parsed date ({date.isoformat()}) is newer than last modification '
            f'({f.modified_time})'
        )

    return year, month, day

def parse_taxonomy(rows):
    taxonomy = {}
    for row in rows[1:]:
        if row[0] and row[1]:
            taxonomy[row[0]] = row[1]
    return taxonomy

def parse_summary_stats(rows, start=0, name='Archetype'):
    while start < len(rows) and (not rows[start] or rows[start][0] != name):
        start += 1
    assert start < len(rows)
    i_row = start + 1
    data = {}
    while i_row < len(rows) and rows[i_row]:
        archetype = rows[i_row][0]
        assert archetype not in data
        if name == 'Subarchetype' and archetype == 'Other':
            i_row += 1
            continue
        data[archetype] = {
            rows[start][i]: rows[i_row][i]
            for i in range(1, len(rows[i_row]))
        }
        i_row += 1
    return data, i_row

def parse_h2h(rows):
    assert not rows[0][0]
    h2h = {}
    for row in rows[1:]:
        sa1 = row[0]
        h2h[sa1] = {}
        for c in range(1, len(row)):
            if row[c]:
                h2h[sa1][rows[0][c]] = row[c]
    return h2h

name_typo = False
NAME_FIX = {
    'yustani': 'yasutani',
    'trailovski': 'trailovsky',
    '42crookedsporks': 'mrsporks',
    'i_btrue': 'i_b_true',
    'joostd b': 'joostdb',
    'j pa93': 'jpa93',
    'oceansou192': 'oceansoul92',
    'l4rsson': 'l4rss0n',
    'schulzcube': 'schulzcubed',
    'pietronel0': 'pietrone10',
    'ref': 'reformedpaolo',
    'mes': 'mestarimatti',
    'mea': 'meatpop',
    # Probably Input name that's wrong here
    'bhowie': 'dimir',
    # sic, somebody has k issues
    'i-z': 'i-zk',
    's063': 's063k',
    'gn42': 'gn42k',
}
def fix_pn(p):
    global name_typo
    p = str(p).lower()
    if p in NAME_FIX:
        p = NAME_FIX[p]
        name_typo = True
    return p

def parse_players(rows):
    player_decks = {}
    player_backup = {}
    for i, row in enumerate(rows[1:], start=1):
        if len(row) < 6: continue
        if row[0] in ['', ' ']: continue
        p1 = fix_pn(row[1])
        if p1 in player_decks:
            log.error(f'Duplicate player "{p1}" (row {i})')
            raise Exception
        player_decks[p1] = row[5]
        player_backup[i] = p1
    return player_decks, player_backup

def split_score(res):
    s1, s2 = res.split('-')
    # rip
    if s1 == 'Jan': s1 = 1
    if s2 == 'Jan': s2 = 1
    return *tuple(map(int, (s1, s2))), f'{s1}-{s2}'

player_name_missing = False
has_bye = False

def parse_matches(event_name, rows, subarchetype, player_decks, player_backup):
    global player_name_missing, has_bye
    pa_map = {}
    pdw = False
    missing_player_data = False
    for i, row in enumerate(rows[1:], start=1):
        if len(row) < 2: continue
        p1 = fix_pn(row[0])
        if p1 == '':
            if i not in player_backup: continue
            p1 = player_backup[i]
            player_name_missing = True
            log.warning(f"Player #{i}'s name was missing, using {p1}")
        if row[1] == '' or row[1] != player_decks[p1]:
            if player_decks[p1] == '':
                log.warning(f'Player {row[0]} deck missing')
                pa_map[p1] = None
                missing_player_data = True
                continue
            log.warning(
                f"Player {p1} deck doesn't match between Input "
                f"({player_decks[p1]}) and Match Up Input "
                f"({row[1]}). Used {player_decks[p1]}"
            )
            row[1] = player_decks[p1]
            pdw = True
        pa_map[p1] = row[1]
        if row[1] == 'Other': continue
        assert row[1] in subarchetype
    matches = {}
    for i, row in enumerate(rows[1:], start=1):
        if len(row) < 2: continue
        p1 = fix_pn(row[0])
        if p1 == '':
            if i not in player_backup: continue
            p1 = player_backup[i]
        sa1 = pa_map[p1]
        if sa1 is None: continue
        if sa1 == 'Other': continue
        if sa1 not in matches:
            matches[sa1] = {}
        for round in range(2, len(row)-1, 2):
            res = row[round+1]
            if res == 'Bye':
                has_bye = True
            if res in ['Bye', 'Draw'] or row[round] == '' or res == '':
                continue
            if res == 45689: res = '2-1' # rip
            if res == 45659: res = '1-2' # rip
            if '-' not in res: # Fix typos
                assert len(res) == 2
                res = res[0] + '-' + res[1]
            s1, s2, res = split_score(res)
            if s1 == s2:
                continue
            p2 = fix_pn(row[round])
            sa2 = pa_map[p2]
            if sa2 == 'Other':
                player_name_missing = True
                continue
            if sa2 is None: continue
            if (event_name == 'Legacy Challenge 32 10/12/2025 - 2' \
                    and {p1, p2} == {'lordoflifegain', 'reformedpaolo'}) or \
               (event_name == 'Legacy Challenge 32 8/9/2026' \
                    and {p1, p2} == {'vash963', 'mmapson125'}) or \
               (event_name == 'Legacy Challenge 32 9/9/2026' \
                    and {p1, p2} == {'freaknightmare', 'blacklotusknight'}):
                res = res[::-1] # Inverted result
            if event_name == 'Legacy Challenge 11/11/2023' \
                    and {p1, p2} == {'susurrus_mtg'}:
                p2 = 'burrarun'
                sa2 = pa_map[p2]
            if event_name == 'Legacy Challenge 1/8/2023' \
                    and {p1, p2} == {'butakov'}:
                p2 = 'mcwinsauce'
                sa2 = pa_map[p2]
            if event_name == 'Legacy Showcase Challenge 5/14/2023' \
                    and {p1, p2} == {'mkc'}:
                p2 = 'themutz'
                sa2 = pa_map[p2]
            assert p1 != p2
            if sa2 not in matches[sa1]:
                matches[sa1][sa2] = {}
            if res not in matches[sa1][sa2]:
                matches[sa1][sa2][res] = 1
            else:
                matches[sa1][sa2][res] += 1
    return matches, pdw, missing_player_data

def results_to_wdl(results):
    wdl = {'W': 0, 'D': 0, 'L': 0}
    if not isinstance(results, list):
        results = [results]
    for res in results:
        for r in res:
            s1, s2, _ = split_score(r)
            if s1 < s2:
                wdl['L'] += res[r]
            elif s1 > s2:
                wdl['W'] += res[r]
            else:
                wdl['D'] += res[r]
    return wdl

RESULT_TYPO = { # Those sheets have typos in match result (e.g.: 01 vs 0-1)
    'Legacy Challenge 4/16/2023',
    'Legacy Challenge 8/5/2023',
    'Legacy Challenge 9/30/2023',
    'Legacy Showcase Challenge 10/22/2023',
    'Legacy Challenge 10/1/2023',
    'Legacy Showcase Challenge 6/8/2025',
    # Suspicious Draw
    'Legacy Showcase Challenge 2/15/2026',
    # A Bye is counted as a loss
    'Legacy Showcase Challenge 3/15/2026',
    # Wrong opponent (self match)
    'Legacy Challenge 1/8/2023',
    'Legacy Showcase Challenge 5/14/2023',
    'Legacy Challenge 11/11/2023',
}


RECORD_TYPO = {
    # The winner was inputed as 8-2 when he ended 9-1
    'Legacy Challenge 32 12/14/2025 - 2',
    # The winner was inputed as 7-2 when he ended 8-1
    'Legacy Challenge 32 3/1/2026 - 2',
    # The winner was inputed as 6-2 when he ended 7-2
    'Legacy Challenge 32 4/24/2026'
}

def check_stats(event_name, matches, stats, taxonomy):
    assert {taxonomy[sa] for sa in matches} == set(stats.keys())
    if event_name in RECORD_TYPO | RESULT_TYPO or player_name_missing:
        return
    for a in stats:
        wdl = results_to_wdl(sum([
            list(matches[sa].values())
            for sa in matches
            if taxonomy[sa] == a
        ], []))
        if event_name == 'Legacy Challenge 1/7/2023' and a == 'Spell Combo':
            wdl['W'] += 1 # A no-show bye was inputed as a win
        if wdl['W'] != stats[a]['Wins (wi)'] or \
           wdl['L'] != stats[a]['Losses (li)']:
            message = (
                f'Archetype {a} {[sa for sa in matches if taxonomy[sa] == a]} '
                f'stats mismatch ({wdl} vs '
                f'{stats[a]['Wins (wi)']}-{stats[a]['Losses (li)']})'
            )
            if not has_bye:
                log.error(message)
                raise Exception
            log.warning(message)

def check_substats(event_name, matches, stats):
    if set(matches.keys()) != set(stats.keys()):
        log.error(
            f"Match Up subarchetypes don't match Overview\n"
            f"MU - O: {set(matches.keys()) - set(stats.keys())}\n"
            f"O - MU: {set(stats.keys()) - set(matches.keys())}"
        )
        raise Exception
    if event_name in RECORD_TYPO | RESULT_TYPO or player_name_missing:
        return
    for sa in matches:
        wdl = results_to_wdl(list(matches[sa].values()))
        if event_name == 'Legacy Challenge 1/7/2023' and \
           sa == 'Oops All Spells':
            wdl['W'] += 1 # A no-show bye was inputed as a win
        if wdl['W'] != stats[sa]['Wins (wi)'] or \
           wdl['L'] != stats[sa]['Losses (li)']:
            message = (
                f'Subarchetype {sa} stats mismatch ({wdl} vs '
                f'{stats[sa]['Wins (wi)']}-{stats[sa]['Losses (li)']})'
            )
            if not has_bye or wdl['L'] != stats[sa]['Losses (li)'] \
                or wdl['W'] > stats[sa]['Wins (wi)']:
                log.error(message)
                raise Exception
            log.warning(message)

def check_h2h(event_name, matches, h2h, pdw):
    if 'Other' in h2h:
        del h2h['Other']
    assert set(matches.keys()) == set(h2h.keys())
    if event_name in {
        # The sheets don't like username with only digits
        'Legacy Super Qualifier 9/9/2023',
        # h2h incomplete formula
        'Legacy Showcase Challenge 3/17/2024',
        'Legacy Showcase Challenge 3/19/2023',
        'Legacy Showcase Challenge 7/2/2023',
        # a 0-1 isn't counted as a loss, but 1-0 is a win
        'Legacy Challenge 32 3/26/2025',
        # A match result was flipped
        'Legacy Challenge 32 10/12/2025 - 2',
        'Legacy Challenge 32 8/9/2026',
        'Legacy Challenge 32 9/9/2026'
    } or event_name in RESULT_TYPO or name_typo: return
    for sa1 in h2h:
        if 'Other' in h2h[sa1]:
            del h2h[sa1]['Other']
        if set(matches[sa1].keys()) != set(h2h[sa1].keys()):
            message = (
                f"H2H matrix and Match Up data for {sa1} doesn't agree:\n"
                f"H2H - MU: {set(h2h[sa1].keys()) - set(matches[sa1].keys())}\n"
                f"MU - H2H: {set(matches[sa1].keys()) - set(h2h[sa1].keys())}"
            )
            if pdw:
                log.warning(message)
                continue
            else:
                log.error(message)
                raise Exception
        for sa2 in h2h[sa1]:
            wdl = results_to_wdl(matches[sa1][sa2])
            if f'{wdl['W']}-{wdl['L']}' != h2h[sa1][sa2]:
                log.error(
                    f'Match Up result of {sa1} vs {sa2} ({wdl}) differs from '
                    f'H2H ({h2h[sa1][sa2]})'
                )
                raise Exception

def process_sheet(drive: Drive, store: Store, f: DriveFile):
    global name_typo, player_name_missing, has_bye
    name_typo = player_name_missing = has_bye = False
    year, month, day = parse_metadata(f)

    sheet = drive.get_sheet(f.id, [
        'Archetypes', 'Overview', 'Subarchetype Matrix Matches', 'Input',
        'Match Up Input'
    ], retries=1)

    taxonomy = parse_taxonomy(sheet['Archetypes'])

    sane_archetype_stats, i = parse_summary_stats(sheet['Overview'])
    sane_subarchetype_stats, _ = parse_summary_stats(
        sheet['Overview'], start=i, name='Subarchetype'
    )
    if 'Subarchetype Matrix Matches' in sheet:
        sane_h2h_matrix = parse_h2h(sheet['Subarchetype Matrix Matches'])
    else: sane_h2h_matrix = None
    player_decks, player_backup = parse_players(sheet['Input'])

    if 'Match Up Input' not in sheet:
        log.warning('Missing Match Up Tab, skipping')
        store.write(
            f.id,
            {
                'event': f.name,
                'year': year,
                'month': month,
                'day': day,
            },
            f.modified_time
        )
        return
    matches, pdw, missing_player_data = parse_matches(
        f.name, sheet['Match Up Input'], set(sane_subarchetype_stats.keys()),
        player_decks, player_backup
    )
    if not missing_player_data:
        check_substats(f.name, matches, sane_subarchetype_stats)
        check_stats(f.name, matches, sane_archetype_stats, taxonomy)
    if sane_h2h_matrix:
        check_h2h(f.name, matches, sane_h2h_matrix, pdw)
    else:
        log.warning('Missing H2H matrix to check parsing')

    data = {
        'event': f.name,
        'year': year,
        'month': month,
        'day': day,
        'subarchetypes': {
            sa: sane_subarchetype_stats[sa] | {'match ups': matches[sa]}
            for sa in matches
        },
        'taxonomy': taxonomy,
    }
    store.write(f.id, data, f.modified_time)

    n_matches = sum(
        sum(matches[sa1][sa2].values())
        for sa1 in matches for sa2 in matches[sa1]
    )
    log.info(
        f'{f.name}: {len({taxonomy[sa] for sa in matches})} archetypes, '
        f'{len(matches)} subarchetypes, {n_matches} matches',
    )

BROKEN_SHEETS = {
    'Legacy Challenge 9/23/2023',
    'Legacy Showcase Challenge 11/26/2023',
    'Legacy Challenge 64 6/9/2024',
    'Legacy Showcase Challenge 8/25/2024',
    'Legacy Challenge 12/30/2023'
}

def collect(
    data_dir: str, creds_file: str, config: dict, force: bool=False,
    limit: int | None=None
):
    store = Store(f'{data_dir}/{config.get('format', 'legacy').lower()}/ldcp')
    drive = Drive(creds_file, log)

    all_files = list(drive.walk_tree(
        config['root_folder_id'],
        # Filter only year folders
        filter=lambda path, name: path != "" or name.isdigit()
        # TODO: Paper events
    ))

    all_sheets = [
        f
        for f in all_files
        if f.mime_type == SPREADSHEET_MIME and f.name not in BROKEN_SHEETS
            and '*NO MERGE*' not in f.name
            and '*MANUAL INPUT*' not in f.name
    ]
    log.info(f'Found {len(all_sheets)} spreadsheets total')

    to_process = [
        f
        for f in all_sheets
        if force or store.needs_processing(f.id, f.modified_time)
    ]
    log.info(f'{len(to_process)} need (re)processing')

    if limit:
        to_process = to_process[:limit]

    failures = 0
    for i, f in enumerate(to_process, start=1):
        log.info(
            f'[{i:>{len(str(len(to_process)))}}/{len(to_process)}] {f.name}, '
            f'{f.folder_path}'
        )
        try:
            process_sheet(
                drive, store, f,
            )
        except Exception as e:
            log.exception(
                f'Failed to process {f.name} ({f.id}) - will retry next run'
            )
            failures += 1
            if isinstance (e, HttpError):
                time.sleep(30)

    store.save_manifest()

    data_sheets = 0
    empty_sheets = 0

    taxonomy = {}
    results = {}
    for f in all_sheets:
        data = store.load(f.id)
        if 'taxonomy' not in data:
            empty_sheets += 1
            continue

        for sa, a in data['taxonomy'].items():
            if sa in taxonomy:
                assert taxonomy[sa] == a
            else:
                taxonomy[sa] = a

        key = datetime.datetime(
            data['year'], data['month'], data['day']
        ).isoformat()
        for sa in data['subarchetypes']:
            if sa not in results:
                results[sa] = {}
            if key not in results[sa]:
                results[sa][key] = []
            results[sa][key].append(
                (data['event'], data['subarchetypes'][sa]['match ups'])
            )

        data_sheets += 1

    with gzip.open(
        store.root / 'all_results.json.gz', 'wt', encoding='UTF-8'
    ) as f:
        json.dump(results, f)

    with open(
        store.root / 'taxonomy.json', 'w', encoding='UTF-8'
    ) as f:
        json.dump(taxonomy, f)

    log.info(
        f'Done. {len(to_process) - failures} processed '
        f'({data_sheets} contain data, '
        f'{empty_sheets} empty), {failures} failed.'
    )
