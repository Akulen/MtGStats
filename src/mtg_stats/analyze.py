import argparse
import datetime
import gzip
import json
import os
from pathlib import Path

import pyecharts as pc

def load_data(source):
    with open(f'{source}/taxonomy.json', 'r', encoding='UTF-8') as f:
        taxonomy = json.load(f)
    with gzip.open(
        f'{source}/all_results.json.gz', 'rt', encoding='UTF-8'
    ) as f:
        results = json.load(f)
    return {
        'taxonomy': taxonomy,
        'results': {
            sa: {
                datetime.datetime.fromisoformat(key): results[sa][key]
                for key in results[sa]
            }
            for sa in results
        }
    }

def process_subarchetype(name, results, taxonomy, events):
    if name == 'Tin Fins':
        print(results['ldcp'].keys())
    dates = sorted(list({
        key
        for source in results if name in results[source]
        for key in results[source][name]
    }))
    if len(dates) == 0:
        return
    calendar = {
        'subarchetype': name,
        'entries': {
            year: [
            ]
            for year in range(dates[0].year, dates[-1].year+1)
        }
    }
    max_n_matches = 0
    for date in dates:
        n_matches = sum(
            h2h[opp][outcome]
            for source in results
            if date in results[source][name]
            for _, h2h in results[source][name][date]
            for opp in h2h
            for outcome in h2h[opp]
        )
        max_n_matches = max(max_n_matches, n_matches)
        calendar['entries'][date.year].append(
            [date.strftime("%Y-%m-%d"), n_matches]
        )
    calendar['max'] = max_n_matches

    win_rates = {}
    for date in dates:
        for source in results:
            if date not in results[source][name]: continue
            json_date = date.strftime("%Y-%m-%d")
            for _, h2h in results[source][name][date]:
                for opp in h2h:
                    if name == opp: continue
                    if opp not in win_rates:
                        win_rates[opp] = {
                            'match': {},
                            'game': {}
                        }
                    if json_date not in win_rates[opp]['match']:
                        win_rates[opp]['match'][json_date] = [0, 0]
                    if json_date not in win_rates[opp]['game']:
                        win_rates[opp]['game'][json_date] = [0, 0]
                    for outcome in h2h[opp]:
                        w, l = map(int, outcome.split('-'))
                        if w > l:
                            win_rates[opp]['match'][json_date][0] += \
                                h2h[opp][outcome]
                        elif w < l:
                            win_rates[opp]['match'][json_date][1] += \
                                h2h[opp][outcome]
                        win_rates[opp]['game'][json_date][0] += w
                        win_rates[opp]['game'][json_date][1] += l
    match_count = {}
    for opp in win_rates:
        match_count[opp] = 0
        for date in win_rates[opp]['match']:
            match_count[opp] += win_rates[opp]['match'][date][0]
            match_count[opp] += win_rates[opp]['match'][date][1]
    match_count = dict(sorted(
        match_count.items(), key=lambda item: item[::-1],
        reverse=True
    )[:9])
    if name == "Sewer-Cam Combo":
        print(match_count)
    win_rates = {
        opp: win_rates[opp]
        for opp in match_count
        if match_count[opp] > 100
    }

    path = Path(f'charts/data/{name}')
    path.mkdir(parents=True, exist_ok=True)

    with gzip.open(path / 'calendar.json.gz', 'wt', encoding='UTF-8') as f:
        json.dump(calendar, f)
    with gzip.open(path / 'win_rates.json.gz', 'wt', encoding='UTF-8') as f:
        json.dump({
            'subarchetype': name,
            'entries': win_rates,
            'min': dates[0].strftime("%Y-%m-%d"),
            'max': dates[-1].strftime("%Y-%m-%d"),
            'events': events
        }, f)
    return

if __name__ == '__main__':
    parser = argparse.ArgumentParser(
        description='Analyse MtG Metagame data and produce plots',
        formatter_class=argparse.ArgumentDefaultsHelpFormatter
    )
    parser.add_argument('--format',
        type=str, choices=['Legacy'], default='Legacy',
        help='Format to analyze'
    )
    parser.add_argument('--data-dir',
        type=str, default='data',
        help='Local folder to store collected data'
    )

    args = parser.parse_args()
    print(args)

    data_folder = f'{args.data_dir}/{args.format.lower()}'
    data_sources = os.listdir(data_folder)
    all_data = {
        source: load_data(f'{data_folder}/{source}')
        for source in data_sources
        if source[-5:] != '.json'
    }

    taxonomy = {}
    for source in all_data:
        for sa, a in all_data[source]['taxonomy'].items():
            if sa == 'Unknown Deck': continue
            if sa in taxonomy:
                assert taxonomy[sa] == a
            else:
                taxonomy[sa] = a
    print(len(taxonomy), 'total subarchetypes')

    with open('data/legacy/events.json', 'r') as f:
        events = json.load(f)

    archetypes = {}
    total_matches = 0
    for subarchetype, archetype in taxonomy.items():
        process_subarchetype(
            subarchetype,
            {
                source: all_data[source]['results']
                for source in all_data
            },
            taxonomy,
            events
        )

        if archetype not in archetypes:
            archetypes[archetype] = {'sas': {}, 'n_matches': 0}

        n_matches = 0
        for source in all_data:
            if subarchetype not in all_data[source]['results']: continue
            for date in all_data[source]['results'][subarchetype]:
                for (_, e) in all_data[source]['results'][subarchetype][date]:
                    for opp in e:
                        for result in e[opp]:
                            n_matches += e[opp][result]
        total_matches += n_matches
        archetypes[archetype]['n_matches'] += n_matches
        archetypes[archetype]['sas'][subarchetype] = {
            'n_matches': n_matches
        }
    for subarchetype, archetype in taxonomy.items():
        archetypes[archetype]['sas'][subarchetype]['share'] = (
            archetypes[archetype]['sas'][subarchetype]['n_matches']
            / total_matches
        )
    for a in archetypes:
        archetypes[a]['sas'] = dict(sorted(
            archetypes[a]['sas'].items(),
            key=lambda item: item[1]['n_matches'],
            reverse=True
        ))
        archetypes[a]['share'] = archetypes[a]['n_matches'] / total_matches
    archetypes = dict(sorted(
        archetypes.items(),
        key=lambda item: item[1]['n_matches'],
        reverse=True
    ))

    with open('charts/data/taxonomy.json', 'w') as f:
        json.dump(archetypes, f)
