"""
Utilities to crawl the Legacy Data Collection Project Google Drive, and collect
the raw data
"""

import datetime
import gzip
import json
import logging
import colorlog
from colorlog.escape_codes import escape_codes as c
import re
import time

from googleapiclient.errors import HttpError

from .drive import Drive, DriveFile, SPREADSHEET_MIME
from .store import Store

color_handler = colorlog.StreamHandler()
color_handler.setFormatter(colorlog.ColoredFormatter(
    fmt='%(asctime)s %(log_color)s%(levelname)s%(reset)s %(message)s',
    log_colors={
        'INFO': 'blue',
        'WARNING': 'yellow',
        'ERROR': 'red',
        'CRITICAL': 'bold_red',
    }
))

logging.basicConfig(
    level=logging.INFO,
    handlers=[color_handler]
)
log = logging.getLogger('collect')

MONTHS = {
    'January': 1,
    'February': 2,
    'March': 3,
    'April': 4,
    'May': 5,
    'June': 6,
    'July': 7,
    'August': 8,
    'September': 9,
    'October': 10,
    'November': 11,
    'December': 12,
}
DATE_RE = re.compile(r'(\d{1,2})/(\d{1,2})/(\d{4})')
ALT_DATE_RE = re.compile(r'(\d{1,2})[/-](\d{1,2})')
FOLDER_DATE_RE = re.compile(r'/(\d{4})/(\d{1,2}) ?- [A-Z][a-z][a-z]+')
ALT_FOLDER_DATE_RE = re.compile(
    rf'/Paper Events/(\d{{4}})/({'|'.join(MONTHS.keys())})'
)
ALT2_FOLDER_DATE_RE = re.compile(r'/Paper Events/(\d{4})')

def parse_metadata(f: DriveFile, m_dates: dict, strict: bool=False):
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
    else:
        m = ALT_FOLDER_DATE_RE.search(f.folder_path)
        if m:
            folder_year, folder_month_name = m.groups()
            folder_year = int(folder_year)
            folder_month = MONTHS[folder_month_name]
        else:
            m = ALT2_FOLDER_DATE_RE.search(f.folder_path)
            if m:
                folder_year, = map(int, m.groups())
    if folder_year != name_year:
        log.warning(
            f"Filename year ({name_year}) doesn't match folder year "
            f"({folder_year})"
        )
        if folder_year is not None and name_year is not None and strict:
            manual_year = m_dates.get(f'{folder_year} - {f.name}', {}) \
                                 .get("year", None)
            if manual_year != folder_year:
                raise Exception('Inconsistent year')
    if folder_month != name_month:
        log.warning(
            f"Filename month ({name_month}) doesn't match folder month "
            f"({folder_month})"
        )
        if folder_month is not None and name_month is not None and strict:
            raise Exception('Inconsistent month')

    year = folder_year
    month = folder_month or name_month
    day = name_day
    yearname = f'{year} - {f.name}'
    if yearname in m_dates:
        m_data = m_dates[yearname]
        if not month and 'month' in m_data:
            month = m_data['month']
        if not day and 'day' in m_data:
            day = m_data['day']
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

def fix_sa(sa):
    if sa == 'Ant': return 'ANT'
    return sa

def parse_summary_stats(rows, start=0, name='Archetype'):
    while start < len(rows) and (not rows[start] or rows[start][0] != name):
        start += 1
    assert start < len(rows)
    i_row = start + 1
    data = {}
    while i_row < len(rows) and rows[i_row]:
        archetype = fix_sa(rows[i_row][0])
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
        sa1 = fix_sa(row[0])
        if sa1 == 'Other': continue
        h2h[sa1] = {}
        for c in range(1, len(row)):
            if row[c]:
                sa2 = fix_sa(rows[0][c])
                if sa2 == 'Other': continue
                h2h[sa1][sa2] = row[c]
    return h2h

def fix_pn(p, m_fixes, name_typo=False):
    p = str(p).lower()
    if p in m_fixes.get('player_name', {}):
        p = m_fixes['player_name'][p]
        name_typo = True
    return p, name_typo

def parse_players(rows, taxonomy, m_fixes):
    player_decks = {}
    player_backup = {}
    player_records = {}
    dup_errors = {}
    diff_arch_player = {}
    player_quote = set()
    name_typo = False
    for i, row in enumerate(rows[1:], start=1):
        if len(row) < 6: continue
        if row[0] in ['', ' ']: continue
        p1, name_typo = fix_pn(row[1], m_fixes, name_typo)
        sa = fix_sa(row[5]) or 'Other'
        iw = int(float(row[2])) if row[2] != '' else 0
        il = int(float(row[3])) if row[3] != '' else 0
        if p1 in player_decks:
            if p1 not in m_fixes.get('duplicated_players', []):
                raise Exception(f'Duplicate player "{p1}" (row {i})')
            else:
                log.warning(f'Duplicate player "{p1}" (row {i})')
                if p1 not in dup_errors:
                    sa_dup, w, l = player_records[p1]
                    dup_errors[p1] = { sa_dup: [w, l] }
                if sa not in dup_errors[p1]:
                    dup_errors[p1][sa] = [0, 0]
                dup_errors[p1][sa][0] += iw
                dup_errors[p1][sa][1] += il
                continue
        player_decks[p1] = fix_sa(row[5])
        if row[2] != '' and row[3] != '':
            player_records[p1] = (sa, iw, il)
        if player_decks[p1] == '':
            player_decks[p1] = 'Other'
            log.warning(f"Couldn't determine player {p1}'s deck")
        elif row[4] != taxonomy.get(player_decks[p1], ''):
            diff_arch_player[p1] = row[4]
        if "'" in p1:
            player_quote.add(player_decks[p1])
        player_backup[i] = p1
    if dup_errors:
        log.warning(
            f'Had to ignore duplicated players: {list(dup_errors.keys())}'
        )
    for p in dup_errors:
        del player_decks[p]
    return (
        player_decks, player_backup, player_records, dup_errors,
        diff_arch_player, player_quote, name_typo
    )

def split_score(res):
    s1, s2 = res.split('-')
    # rip
    s1, s2 = map(lambda s: 1 if s == 'Jan' else int(s), (s1, s2))
    return s1, s2, f'{s1}-{s2}'

def soft_error(message, strict=False):
    if strict:
        raise Exception(message)
    log.warning(message)

def record_error(match_error, sa1, sa2, res, val=1):
    if sa1 not in match_error:
        match_error[sa1] = {}
    if sa2 not in match_error[sa1]:
        match_error[sa1][sa2] = [0, 0]
    s1, s2, _ = split_score(res)
    if s1 < s2:
        match_error[sa1][sa2][1] += val
    elif s1 > s2:
        match_error[sa1][sa2][0] += val

H2H_RANGE_RE = re.compile(r"'Match Up Input'!\$[A-Z]+:\$([A-Z]+)")

def max_h2h_col(lazy_h2h_formula):
    if not lazy_h2h_formula:
        return None
    for cell in lazy_h2h_formula[2][1:]:
        m = H2H_RANGE_RE.search(str(cell))
        if m:
            col = 0
            for ch in m.group(1):
                col = col * 26 + (ord(ch) - ord('A') + 1)
            return col - 1
    return None

def parse_matches(
    event_name,
    year,
    rows,
    subarchetypes,
    h2h_max_col,
    taxonomy,
    player_decks,
    player_backup,
    player_records,
    dup_errors,
    diff_arch_player,
    name_typo,
    m_fixes,
    strict=False
):
    pa_map = {}
    pdw = set()
    missing_player_data = False
    match_error = {}
    diff_deck_player = {}
    h2h_to_remove = {}
    h2h_to_add = {}
    h2h_match_error = {}
    reallocate = {}
    player_name_missing = set()
    has_bye = {}
    p_wl = {}
    for dups in dup_errors.values():
        for sa, [w, l] in dups.items():
            if sa != 'Other':
                record_error(match_error, sa, 'duplicated_player', '2-0', -w)
                record_error(match_error, sa, 'duplicated_player', '0-2', -l)
    # Get a map associating players to their decks
    for i, row in enumerate(rows[1:], start=1):
        if len(row) < 2: continue
        p1, name_typo = fix_pn(row[0], m_fixes, name_typo)
        add_missing = False
        if p1 == '':
            if i not in player_backup:
                soft_error(f'Player #{i} missing in match results', strict)
                continue
            p1 = player_backup[i]
            add_missing = True
            log.warning(f"Player #{i}'s name was missing, using {p1}")
        if p1 not in player_decks:
            if p1 == '#ref! (reference does not exist.)':
                continue
            if p1 in dup_errors:
                continue
            raise Exception(f'Unknown player "{p1}"')
        if player_decks[p1] == '':
            log.warning(f'Player {row[0]} deck missing')
            pa_map[p1] = None
            missing_player_data = True
        else:
            if row[1] == '' or row[1] != player_decks[p1]:
                log.warning(
                    f"Player {p1} deck doesn't match between Input "
                    f"({player_decks[p1]}) and Match Up Input "
                    f"({row[1]}). Used {player_decks[p1]}"
                )
                # pdw.add(row[1])
                diff_deck_player[p1] = row[1]
                row[1] = player_decks[p1]
                # pdw.add(player_decks[p1])
            pa_map[p1] = fix_sa(row[1])
        if pa_map[p1] != 'Other' and pa_map[p1] not in subarchetypes:
            raise Exception(
                f'Deck {pa_map[p1]} of player {p1} missing from summary page'
            )
        if add_missing:
            player_name_missing.add(pa_map[p1])
    matches = {}
    # Parse actual matches
    found_empty_row = -1
    for i, row in enumerate(rows[1:], start=1):
        if len(row) < 2:
            found_empty_row = i
            continue
        if found_empty_row != -1:
            soft_error(
                f'Row {i} is not empty after empty row {found_empty_row}',
                strict
            )
        p1, name_typo = fix_pn(row[0], m_fixes, name_typo)
        if p1 == '':
            if i not in player_backup: continue
            p1 = player_backup[i]
        if p1 in dup_errors:
            sa1 = list(dup_errors[p1].keys())
        elif p1 == '#ref! (reference does not exist.)':
            continue
        else:
            assert p1 in player_decks
            sa1 = pa_map[p1]
            if sa1 in ['Other', 'Unknown Deck']: continue
            assert sa1 is not None
            if sa1 not in matches:
                matches[sa1] = {}
        if p1 in m_fixes.get('wrong_player_res', {}):
            w, l = m_fixes['wrong_player_res'][p1]
            record_error(match_error, sa1, 'manual_error', '2-0', w)
            record_error(match_error, sa1, 'manual_error', '0-2', l)
        for round in range(2, len(row)-1, 2):
            res = str(row[round+1]).strip()
            if p1 not in p_wl:
                p_wl[p1] = [0, 0, 0]
            if res.lower() == 'bye':
                has_bye[sa1] = has_bye.get(sa1, 0) + 1
                p_wl[p1][2] += 1
            if res.lower() in ['bye', 'draw', 'split', 'd']:
                continue
            if row[round] == '' or res == '':
                empty_tail = True
                for x in row[round:-1]:
                    if x != '':
                        empty_tail = False
                        break
                if not empty_tail:
                    soft_error(
                        f'Player {p1} missing opp ({row[round]}) or result '
                        f'({res}) in round {round // 2}',
                        strict
                    )
                continue
            p2, name2_typo = fix_pn(
                row[round], m_fixes, False
            )
            name_typo = name_typo or name2_typo
            if p2 not in player_decks or p2 not in pa_map:
                # if p2 == 'damian vance':
                #     p2 = 'jared cassarly'
                if p2 in dup_errors:
                    for sa in dup_errors[p2]:
                        if sa1 not in h2h_to_remove:
                            h2h_to_remove[sa1] = set()
                        h2h_to_remove[sa1].add(sa)
                        record_error(h2h_match_error, sa1, sa, res, -1)
                    record_error(match_error, sa1, 'duplicated player', res, -1)
                    if '-' in res and len(res) == 3:
                        s1, s2, _ = split_score(res)
                        if s1 > s2:
                            p_wl[p1][0] += 1
                        elif s1 < s2:
                            p_wl[p1][1] += 1
                    continue
                elif p2 in m_fixes.get('wrong opponent', {}):
                    record_error(match_error, sa1, player_decks[p2], res, -1)
                    p2 = m_fixes['wrong opponent'][p2]
                    record_error(match_error, sa1, pa_map[p2], res)
                else:
                    soft_error(
                        f'Skipping match between {p1} and unknown player {p2}',
                        strict
                    )
                    continue
            sa2 = pa_map[p2]
            if sa2 is None:
                soft_error(
                    f'Skipping match between {p1} and player {p2} with unknown '
                    f'deck',
                    strict
                )
                continue
            # if res == '36557': res = '2-0'
            if str(res) in m_fixes.get('wrong_res', {}):
                res = m_fixes['wrong_res'][str(res)]
                record_error(match_error, sa1, sa2, res)
            message = (
                f'Invalid match result in round {round//2} for player '
                f'{p1} ({sa1}) against {p2} ({sa2}): {res}'
            )
            if '-' not in res: # Fix typos
                if len(res) != 2:
                    soft_error(message, strict)
                    continue
                res0 = res
                res = res[0] + '-' + res[1]
                log.warning(
                    f'Mistake in match result ({res0}) between {p1} and {p2}, '
                    f'fixed to {res}'
                )
                record_error(match_error, sa1, sa2, res)
            if len(res) != 3:
                if res == '-2':
                    res0 = res
                    res = '0-2'
                    soft_error(
                        f'Mistake in match result ({res0}) between '
                        f'{p1} and {p2}, fixed to {res}',
                        strict
                    )
                else:
                    soft_error(message, strict)
                    continue
            res_typos = m_fixes.get('res_typo', {})
            if p1 in res_typos and p2 in res_typos[p1]:
                res0 = res
                res = res_typos[p1][p2]
                record_error(match_error, sa1, sa2, res0, -1)
                record_error(match_error, sa1, sa2, res, 1)
                h2h_to_add.setdefault(sa1, set()).add(sa2)
                log.info(
                    f'Fixed wrong match result {res0} between {p1} and {p2} to'
                    f'{res}'
                )
            s1, s2, res = split_score(res)
            if s1 == s2: # Ignore draws
                continue
            if s1 == 3 or s2 == 3 or \
                    (s1 == 1 and s2 == 0) or (s1 == 0 and s2 == 1):
                h2h_to_add.setdefault(sa1, set()).add(sa2)
            if {p1, p2} == set(m_fixes.get('inverted_result', [])):
                log.info(f'Fixed inverted result {res} between {p1} and {p2}')
                record_error(match_error, sa1, sa2, res, -1)
                res = res[::-1]
                record_error(match_error, sa1, sa2, res)
            if p1 == p2:
                fix = m_fixes.get('selfplay', {})
                message = f'{p1} plays him/herself in round {round // 2}'
                if p1 in fix:
                    p2 = fix[p1]
                    sa2 = pa_map[p2]
                    record_error(match_error, sa1, sa2, res)
                    record_error(match_error, sa1, sa1, res, -1)
                    log.warning(f'{message}, fixed to {p2} instead')
                    if sa1 not in h2h_to_add:
                        h2h_to_add[sa1] = set()
                    h2h_to_add[sa1].add(sa2)
                    if sa1 not in h2h_to_remove:
                        h2h_to_remove[sa1] = set()
                    h2h_to_remove[sa1].add(sa1)
                else:
                    cands = set()
                    for _row in rows[1:]:
                        if len(_row) <= round: continue
                        cand, _ = fix_pn(_row[round], m_fixes)
                        if cand == p1 and _row[0].lower() != p1:
                            cands.add(_row[0])
                    raise Exception(
                        f'{message}, were they playing against one of {cands} '
                        f'instead?'
                    )
            if s1 > s2:
                p_wl[p1][0] += 1
            elif s1 < s2:
                p_wl[p1][1] += 1
            if p1 in dup_errors:
                for sa in sa1:
                    if sa not in h2h_to_remove:
                        h2h_to_remove[sa] = set()
                    h2h_to_remove[sa].add(sa2)
                    record_error(h2h_match_error, sa, sa2, res, -1)
                continue
            if sa2 not in matches[sa1]:
                matches[sa1][sa2] = {}
            if res not in matches[sa1][sa2]:
                matches[sa1][sa2][res] = 1
            else:
                matches[sa1][sa2][res] += 1
            if h2h_max_col is not None and round + 1 > h2h_max_col:
                record_error(h2h_match_error, sa1, sa2, res)
                h2h_to_remove.setdefault(sa1, set()).add(sa2)
            if p2.isdecimal() and year < 2026:
                record_error(match_error, sa1, sa2, res)
                h2h_to_add.setdefault(sa1, set()).add(sa2)
            if name2_typo:
                record_error(h2h_match_error, sa1, sa2, res)
                if sa1 not in h2h_to_add:
                    h2h_to_add[sa1] = set()
                h2h_to_add[sa1].add(sa2)
            if "'" in p1:
                record_error(match_error, sa1, sa2, res)
            if p1 in diff_deck_player:
                record_error(h2h_match_error, sa1, sa2, res)
                record_error(
                    h2h_match_error, diff_deck_player[p1], sa2, res, -1
                )
                if sa1 not in h2h_to_add:
                    h2h_to_add[sa1] = set()
                h2h_to_add[sa1].add(sa2)
                if diff_deck_player[p1] not in h2h_to_remove:
                    h2h_to_remove[diff_deck_player[p1]] = set()
                h2h_to_remove[diff_deck_player[p1]].add(sa2)
            if p1 in diff_arch_player:
                record_error(reallocate, taxonomy[sa1], taxonomy[sa2], res)
                record_error(
                    reallocate, diff_arch_player[p1], taxonomy[sa2], res, -1
                )

    suggested_fixes = {}
    for p, (mw, ml, mbyes) in p_wl.items():
        if p not in player_records \
                or p in m_fixes.get('wrong_player_res', {}) \
                or p in dup_errors:
            continue
        _, iw, il = player_records[p]
        # Ignore standard Byes where Input credited +1 Win
        if mw + mbyes == iw and ml == il:
            continue
        if (mw, ml) != (iw, il):
            suggested_fixes[p] = [mw - iw, ml - il]
            log.warning(
                f'Player {p} ({pa_map[p]}): Match Up Input={mw}-{ml} '
                f'(byes={mbyes}) vs Input={iw}-{il}\n    -> suggested '
                f'wrong_player_res: "{p}": [{mw - iw}, {ml - il}]'
            )

    return (
        matches, pdw, missing_player_data, match_error, reallocate,
        name_typo, player_name_missing, has_bye, h2h_to_remove, h2h_to_add,
        h2h_match_error
    )

def results_to_wdl(results):
    weird = [0, 0]
    wdl = {'W': 0, 'D': 0, 'L': 0}
    if not isinstance(results, list):
        results = [results]
    for res in results:
        for r in res:
            s1, s2, _ = split_score(r)
            if s1 > 2:
                weird[0] += 1
            if s2 > 2:
                weird[1] += 1
            if s1 == 1 and s2 == 0:
                weird[0] += 1
            if s1 == 0 and s2 == 1:
                weird[1] += 1
            if s1 < s2:
                wdl['L'] += res[r]
            elif s1 > s2:
                wdl['W'] += res[r]
            else:
                wdl['D'] += res[r]
    return wdl, weird

def check_stats(
    event_name,
    matches,
    stats,
    sub_stats,
    taxonomy,
    match_error,
    player_name_missing,
    has_bye,
    m_fixes
):
    tax_archs = {taxonomy[sa] for sa in matches}
    stats_archs = set(stats.keys())
    if tax_archs - {'Unknown'} != stats_archs - {'Unknown'}:
        raise Exception(
            f'Taxonomy mismatched with stats\n{tax_archs}\n{stats_archs}'
        )
    bye_win_swap = set(map(
        lambda sa: taxonomy[sa],
        m_fixes.get('bye-win swap', [])
    ))
    for a in stats:
        wdl, weird = results_to_wdl(sum([
            list(matches[sa].values())
            for sa in matches
            if taxonomy[sa] == a
            and sa not in m_fixes.get('taxonomy gaps', {})
        ], []))
        if a in bye_win_swap:
            wdl['W'] += 1 # A no-show bye was inputed as a win
        tw = stats[a]['Wins (wi)']
        tl = stats[a]['Losses (li)']
        if wdl['W'] != tw or wdl['L'] != tl:
            win_offset, loss_offset = 0, 0
            win_weird = -weird[0]
            loss_weird = -weird[1]
            if wdl['W'] + win_weird == tw and wdl['L'] + loss_weird == tl:
                continue
            for sa, [w, l] in match_error.get(a, {}).items():
                win_offset -= w
                loss_offset -= l
            if (
                wdl['W'] + win_offset == tw
                and wdl['L'] + loss_offset == tl
            ) or (
                wdl['W'] + win_offset + win_weird == tw
                and wdl['L'] + loss_offset + loss_weird == tl
            ):
                continue
            win_offset += win_weird
            loss_offset += loss_weird
            if (
                tw - has_bye.get(a, 0) <= wdl['W'] + win_offset <= tw
                and wdl['L'] + loss_offset == tl
            ) or (
                tw - has_bye.get(a, 0) <= wdl['W'] <= tw
                and wdl['L'] == tl
            ):
                continue
            message = (
                f'Archetype {a} {[sa for sa in matches if taxonomy[sa] == a]} '
                f'stats mismatch ({wdl} vs '
                f'{tw}-{tl}, with {has_bye.get(a, 0)} byes, {weird} weirdness, '
                f'and a W-L offset of {win_offset} - {loss_offset})'
            )
            for sa in matches:
                if taxonomy[sa] != a: continue
                sssa = sub_stats[sa]
                sub_wdl, _sub_weird = results_to_wdl(list(matches[sa].values()))
                message += (
                    f'\n{sa:<20}: {str(sub_wdl):<27} vs '
                        f'{sssa['Wins (wi)']:<2}-{sssa['Losses (li)']:>2})'
                )
            soft_error(message, True)

def check_substats(
    event_name,
    matches,
    stats,
    match_error,
    player_quote,
    player_name_missing,
    has_bye,
    m_fixes
):
    if set(matches.keys()) != set(stats.keys()):
        raise Exception(
            f"Match Up subarchetypes don't match Overview\n"
            f"MU - O: {set(matches.keys()) - set(stats.keys())}\n"
            f"O - MU: {set(stats.keys()) - set(matches.keys())}"
        )
    for sa in matches:
        wdl, weird = results_to_wdl(list(matches[sa].values()))
        if sa in m_fixes.get('bye-win swap', []):
            wdl['W'] += 1 # A no-show bye was inputed as a win
        tw = stats[sa]['Wins (wi)']
        tl = stats[sa]['Losses (li)']
        if wdl['W'] != tw or wdl['L'] != tl:
            win_offset = -weird[0]
            loss_offset = -weird[1]
            if wdl['W'] + win_offset == tw and wdl['L'] + loss_offset == tl:
                continue
            for _, [w, l] in match_error.get(sa, {}).items():
                win_offset -= w
                loss_offset -= l
            if wdl['W'] + win_offset == tw and wdl['L'] + loss_offset == tl:
                continue
            if (
                tw - has_bye.get(sa, 0) <= wdl['W'] + win_offset <= tw
                and wdl['L'] + loss_offset == tl
            ) or (
                tw - has_bye.get(sa, 0) <= wdl['W'] <= tw
                and wdl['L'] == tl
            ):
                continue
            soft_error(
                f'Subarchetype {sa} stats mismatch ({wdl} vs '
                f'{stats[sa]['Wins (wi)']}-{stats[sa]['Losses (li)']})',
                sa not in player_quote and sa not in player_name_missing
            )

def check_h2h(
    event_name,
    matches,
    h2h,
    header,
    h2h_formula,
    pdw,
    match_error,
    name_typo,
    h2h_to_remove,
    h2h_to_add,
    h2h_match_error,
    m_fixes,
    strict
):
    matches_keys = set(matches.keys())
    h2h_keys = set(h2h.keys())
    if 'Unknown Deck' in h2h_keys:
        h2h_keys.remove('Unknown Deck')
    if matches_keys != h2h_keys:
        raise Exception(
            f"Matches subarchetypes don't match H2H matrix\n"
            f"{matches_keys}\n{h2h_keys}"
        )
    missing_warned = set()
    for sa1 in h2h:
        if sa1 in ['Unknown Deck', 'Other Spell Combo']: continue
        match_keys = set(matches[sa1].keys())
        h2h_keys = set(h2h[sa1].keys())
        if 'Unknown Deck' in h2h_keys:
            h2h_keys.remove('Unknown Deck')
        if sa1 in m_fixes.get('missing h2h', {}):
            for sa2 in m_fixes['missing h2h'][sa1]:
                match_keys.remove(sa2)
        if match_keys != h2h_keys:
            forms = h2h_formula[2]
            for sa2 in list(match_keys - h2h_keys):
                if sa2 in ['Other', 'Unknown Deck']:
                    match_keys.remove(sa2)
                    continue
                if sa2 not in header and sa2 == 'ANT':
                    col = header.index('Ant')
                else:
                    col = header.index(sa2)
                if len(forms) <= col or forms[col] == '':
                    if sa2 not in missing_warned:
                        log.warning(
                            f'Sheet H2H Matrix missing formula for column '
                            f'{sa2}, missing {sa1}'
                        )
                        missing_warned.add(sa2)
                    match_keys.remove(sa2)
        if match_keys != h2h_keys:
            for sa2 in list(h2h_keys - match_keys):
                if sa2 in h2h_to_remove.get(sa1, set()):
                    h2h_keys.remove(sa2)
                    log.warning(f'Ignored H2H {sa1} vs {sa2}')
            for sa2 in list(match_keys - h2h_keys):
                if sa2 in h2h_to_add.get(sa1, set()):
                    match_keys.remove(sa2)
                    log.warning(f'Ignored Match {sa1} vs {sa2}')
        for to_ignore in ['Other Spell Combo', 'Other Tempo']:
            if to_ignore in match_keys - h2h_keys:
                soft_error(f'Ignored {to_ignore} matchup for {sa1}', strict)
                match_keys.remove(to_ignore)
        if match_keys != h2h_keys:
            soft_error(
                f"H2H matrix and Match Up data for {sa1} doesn't agree:\n"
                f"H2H - MU: {h2h_keys - match_keys}\n"
                f"MU - H2H: {match_keys - h2h_keys}",
                sa1 not in ['Other Tempo', "Death's Shadow"] and
                sa1 not in pdw and
                'wrong_res' not in m_fixes
            )
        for sa2 in h2h[sa1]:
            if sa2 == 'Unknown Deck':
                continue
            wdl, weird = results_to_wdl(matches[sa1].get(sa2, []))
            t = h2h[sa1][sa2]
            if f'{wdl['W']}-{wdl['L']}' != t:
                win_offset = -weird[0]
                loss_offset = -weird[1]
                if f'{wdl['W']+win_offset}-{wdl['L']+loss_offset}' == t:
                    continue
                [w, l] = match_error.get(sa1, {}).get(sa2, [0, 0])
                win_offset -= w
                loss_offset -= l
                if f'{wdl['W']+win_offset}-{wdl['L']+loss_offset}' == t:
                    continue
                [w, l] = h2h_match_error.get(sa1, {}).get(sa2, [0, 0])
                win_offset -= w
                loss_offset -= l
                if f'{wdl['W']+win_offset}-{wdl['L']+loss_offset}' == t:
                    continue
                soft_error(
                    f'Match Up result of {sa1} vs {sa2} ({wdl}) differs '
                    f'from H2H ({h2h[sa1][sa2]})',
                    (
                        sa1 not in pdw
                        and 'wrong_res' not in m_fixes
                    ) or strict
                )

def process_sheet(
    drive: Drive,
    store: Store,
    f: DriveFile,
    m_dates: dict,
    m_fixes: dict,
    strict: bool=False,
):
    year, month, day = parse_metadata(f, m_dates, strict)
    m_fixes = m_fixes.get(f.name, {})

    sheet = drive.get_sheet(f.id, [
        'Archetypes', 'Overview', 'Subarchetype Matrix Matches', 'Input',
        'Match Up Input'
    ], retries=1, one_by_one='single_tabs' in m_fixes)

    taxonomy = parse_taxonomy(sheet['Archetypes'])
    for sa, a in m_fixes.get('taxonomy gaps', {}).items():
        taxonomy[sa] = a

    sane_archetype_stats, i = parse_summary_stats(sheet['Overview'])
    sane_subarchetype_stats, _ = parse_summary_stats(
        sheet['Overview'], start=i, name='Subarchetype'
    )
    if 'Subarchetype Matrix Matches' in sheet:
        sane_h2h_matrix = parse_h2h(sheet['Subarchetype Matrix Matches'])
        lazy_h2h_formula = drive.get_lazy_tab(
            f.id, 'Subarchetype Matrix Matches'
        )
    else:
        log.warning('Missing checking H2H matrix')
        sane_h2h_matrix = None
        lazy_h2h_formula = None
    (
        player_decks, player_backup, player_records, dup_errors,
        diff_arch_player, player_quote, name_typo
    ) = parse_players(
        sheet['Input'], taxonomy, m_fixes
    )

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
    (
        matches, pdw, missing_player_data, match_error, reallocate,
        name_typo, player_name_missing, has_bye, h2h_to_remove, h2h_to_add,
        h2h_match_error
    ) = parse_matches(
        f.name,
        year,
        sheet['Match Up Input'],
        set(sane_subarchetype_stats.keys()),
        max_h2h_col(lazy_h2h_formula),
        taxonomy,
        player_decks,
        player_backup,
        player_records,
        dup_errors,
        diff_arch_player,
        name_typo,
        m_fixes,
        strict
    )
    has_bye_arch = {}
    for sa in has_bye:
        has_bye_arch[taxonomy[sa]] = \
            has_bye_arch.get(taxonomy[sa], 0) + has_bye[sa]
    match_error_arch = {}
    for sa1, sme in match_error.items():
        if sa1 not in taxonomy: continue
        a1 = taxonomy[sa1]
        if a1 not in match_error_arch:
            match_error_arch[a1] = {}
        for sa2, [w, l] in sme.items():
            if sa2 not in taxonomy: a2 = 'Other'
            else: a2 = taxonomy[sa2]
            if a2 not in match_error_arch[a1]:
                match_error_arch[a1][a2] = [0, 0]
            match_error_arch[a1][a2][0] += w
            match_error_arch[a1][a2][1] += l
    for a1, sme in reallocate.items():
        if a1 not in match_error_arch:
            match_error_arch[a1] = {}
        for a2, [w, l] in sme.items():
            if a2 not in match_error_arch[a1]:
                match_error_arch[a1][a2] = [0, 0]
            match_error_arch[a1][a2][0] += w
            match_error_arch[a1][a2][1] += l
    if not missing_player_data:
        if 'Unknown Deck' in sane_subarchetype_stats:
            del sane_subarchetype_stats['Unknown Deck']
        check_substats(
            f.name,
            matches,
            sane_subarchetype_stats,
            match_error,
            player_quote,
            player_name_missing,
            has_bye,
            m_fixes
        )
        if 'Other' in sane_archetype_stats:
            del sane_archetype_stats['Other']
        check_stats(
            f.name,
            matches,
            sane_archetype_stats,
            sane_subarchetype_stats,
            taxonomy,
            match_error_arch,
            player_name_missing,
            has_bye_arch,
            m_fixes
        )
    if sane_h2h_matrix:
        assert lazy_h2h_formula
        check_h2h(
            f.name,
            matches,
            sane_h2h_matrix,
            sheet['Subarchetype Matrix Matches'][0],
            lazy_h2h_formula,
            pdw,
            match_error,
            name_typo,
            h2h_to_remove,
            h2h_to_add,
            h2h_match_error,
            m_fixes,
            strict
        )
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
        f'{c['green']}{f.name}: {len({taxonomy[sa] for sa in matches})} '
        f'archetypes, {len(matches)} subarchetypes, {n_matches} '
        f'matches{c['reset']}\n',
    )

def collect(
    data_dir: str, creds_file: str, config: dict, force: bool=False,
    limit: int | None=None, skip: int | None=None, strict: bool=False
):
    store = Store(f'{data_dir}/{config.get('format', 'legacy').lower()}/ldcp')
    drive = Drive(creds_file, log)

    all_files = list(drive.walk_tree(
        config['root_folder_id'],
        # Filter only year folders
        filter=lambda path, name: (
            (path != '' or name.isdigit()) # MTGO
            or (name == 'Paper Events') # Paper
        ) and name != 'Archived'
    ))

    with open(store.root / 'manual_dates.json', 'r') as f:
        MANUAL_DATES = json.load(f)
    with open(store.root / 'manual_fixes.json', 'r') as f:
        MANUAL_FIXES = json.load(f)

    def validate_sheet(sheet):
        if sheet.mime_type != SPREADSHEET_MIME:
            return False
        if 'broken' in MANUAL_FIXES.get(sheet.name, {}):
            return False
        for invalid_str in ['*NO MERGE*', '*MANUAL INPUT*']:
            if invalid_str in sheet.name:
                return False
        return True

    mtgo_sheets = [
        f
        for f in all_files
        if validate_sheet(f)
            and not f.folder_path.startswith('/Paper Events/')
    ]
    paper_sheets = [
        f
        for f in all_files
        if validate_sheet(f)
            and f.folder_path.startswith('/Paper Events/')
    ]
    log.info(
        f'Found {len(mtgo_sheets)} MTGO + {len(paper_sheets)} Paper '
        f'spreadsheets (total {len(mtgo_sheets) + len(paper_sheets)})'
    )

    mtgo_process = [
        f
        for f in mtgo_sheets
        if force or store.needs_processing(f.id, f.modified_time)
    ]
    paper_process = [
        f
        for f in paper_sheets
        if force or store.needs_processing(f.id, f.modified_time)
    ]
    log.info(
        f'{len(mtgo_process)} MTGO + {len(paper_process)} Paper need '
        f'(re)processing (total {len(mtgo_process) + len(paper_process)})\n'
    )

    to_process = [
        ('MTGO', f) for f in mtgo_process
    ] + [
        ('Paper', f) for f in paper_process
    ]
    if skip:
        to_process = to_process[skip:]
    if limit:
        to_process = to_process[:limit]

    failures = 0
    for i, (tp, f) in enumerate(to_process, start=1):
        log.info(
            f'[{i:>{len(str(len(to_process)))}}/{len(to_process)}] {tp}: '
            f'{c['green']}{f.name}{c['reset']}, {f.folder_path}'
        )
        try:
            process_sheet(
                drive, store, f, MANUAL_DATES, MANUAL_FIXES, strict
            )
        except Exception as e:
            log.exception(
                f'Failed to process {f.name} ({f.id}) - will retry next run\n'
            )
            failures += 1
            if isinstance (e, HttpError):
                time.sleep(30)

    store.save_manifest()

    data_sheets = 0
    empty_sheets = 0

    taxonomy = {}
    results = {}
    TAXONOMY_ERRORS = {
        'Oops All Spells': 'Spell Combo',
        'GW Depths': 'Land Based/Fair GSZ',
        'TEG': 'Spell Combo'
    }
    for f in mtgo_sheets + paper_sheets:
        try:
            data = store.load(f.id)
        except:
            continue
        if 'taxonomy' not in data:
            empty_sheets += 1
            continue

        for sa, a in data['taxonomy'].items():
            if sa in taxonomy:
                if taxonomy[sa] != a:
                    if TAXONOMY_ERRORS.get(sa, '') == taxonomy[sa]:
                        continue
                    log.error(
                        f'Taxonomy mimatch for sheet {f.name} and subarchetype '
                        f'{sa}: {a} vs {taxonomy[sa]}'
                    )
                    assert False
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
            event_name = data['event']
            if f.folder_path.startswith('/Paper Events/'):
                event_name = 'paper|' + event_name
            else:
                event_name = 'mtgo|' + event_name
            results[sa][key].append(
                (event_name, data['subarchetypes'][sa]['match ups'])
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
