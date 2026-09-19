#!/usr/bin/env python3
"""Checks prepared VSIXs against the extension checkout and keeps resumable per-registry
publication receipts. release.sh runs it from the extension folder."""
import argparse
import hashlib
import json
import pathlib
import subprocess
import zipfile

TARGETS = {'linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64', 'win32-arm64'}
REGISTRIES = ('vsce', 'ovsx')


def git(*args: str) -> str:
    return subprocess.check_output(['git', *args], text=True).strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('manifest', type=pathlib.Path)
    parser.add_argument('--record', nargs=2, metavar=('REGISTRY', 'TARGET'))
    parser.add_argument('--pending', choices=REGISTRIES)
    parser.add_argument('--complete', action='store_true')
    args = parser.parse_args()
    manifest = args.manifest.resolve()
    directory = manifest.parent
    artifacts = json.loads(manifest.read_text())
    package = json.loads(pathlib.Path('package.json').read_text())

    assert not git('status', '--porcelain'), 'The release checkout must be clean'
    assert len(artifacts) == len(TARGETS) and {a['vsix_target'] for a in artifacts} == TARGETS, 'Expected all six targets'
    assert len({a['source_sha256'] for a in artifacts}) == 1, 'The engines come from different sources'
    assert len({a['commit'] for a in artifacts}) == 1, 'The engines come from different commits'
    assert len({a['extension_commit'] for a in artifacts}) == 1, 'The packages come from different commits'
    assert git('rev-parse', artifacts[0]['extension_commit'] + '^{tree}') == git('rev-parse', 'HEAD^{tree}'), \
        'The release checkout differs from the commit that was packaged'
    for a in artifacts:
        assert a['version'] == package['version'], 'A package has a different version from package.json'
        assert not a['dirty'] and not a['extension_dirty'], 'Packages must come from clean commits'
        path = directory / a['vsix']
        assert path.parent == directory and path.is_file(), f'Missing package {a["vsix"]}'
        assert hashlib.sha256(path.read_bytes()).hexdigest() == a['vsix_sha256'], f'{a["vsix"]} changed after packaging'
        with zipfile.ZipFile(path) as vsix:
            inner = json.loads(vsix.read('extension/package.json'))
            assert (inner['name'], inner['publisher'], inner['version']) == (package['name'], package['publisher'], package['version']), 'Extension identity mismatch'
            for relative, digest in a['files'].items():
                assert hashlib.sha256(vsix.read('extension/' + relative)).hexdigest() == digest, f'{relative} changed in {a["vsix"]}'

    receipt = directory / 'publication-state.json'
    state = json.loads(receipt.read_text()) if receipt.exists() else {}
    if args.record:
        registry, target = args.record
        assert registry in REGISTRIES and target in TARGETS
        artifact = next(a for a in artifacts if a['vsix_target'] == target)
        state[f'{registry}:{target}'] = artifact['vsix_sha256']
        temporary = receipt.with_suffix('.tmp')
        temporary.write_text(json.dumps(state, indent=2) + '\n')
        temporary.replace(receipt)
    if args.pending:
        for a in artifacts:
            if state.get(f'{args.pending}:{a["vsix_target"]}') != a['vsix_sha256']:
                print(f'{directory / a["vsix"]}\t{a["vsix_target"]}')
    if args.complete:
        done = all(state.get(f'{r}:{a["vsix_target"]}') == a['vsix_sha256'] for a in artifacts for r in REGISTRIES)
        raise SystemExit(0 if done else 1)


if __name__ == '__main__':
    main()
