import argparse

import yaml

from .data import ldc as ldcp

if __name__ == '__main__':
    parser = argparse.ArgumentParser(
        description='Data Collector',
        formatter_class=argparse.ArgumentDefaultsHelpFormatter
    )
    parser.add_argument('credentials',
        type=str,
        help='Path to the Google service account JSON key file'
    )
    parser.add_argument('--data-dir',
        type=str, default='data',
        help='Local folder to store collected data'
    )
    parser.add_argument('--force',
        action='store_true',
        help='Recollect everything'
    )
    parser.add_argument('--limit',
        type=int, default=None,
        help='Only process at most N events'
    )
    parser.add_argument('--data-source',
        type=str, choices=['LDCP'], default='LDCP',
        help='Which data to collect. (LDCP is the Legacy Data Collection '
             'Project)'
    )
    args = parser.parse_args()

    with open(f'config/{args.data_source.lower()}.yml', 'r') as f:
        args.config = yaml.safe_load(f)
    print(args)

    if args.data_source == 'LDCP':
        ldcp.collect(
            args.data_dir, args.credentials, args.config, args.force, args.limit
        )
    else:
        raise NotImplementedError(args.data_source)
