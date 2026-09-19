#!/usr/bin/env python3
"""Packages one VSIX per platform from the engine builds scripts/build.py prepared, then
checks each package's contents and writes the manifest release.sh publishes from.

    scripts/package.py --artifacts ~/.cache/qdf-release/artifacts --out ~/.cache/qdf-release/vsix
"""
import argparse
import hashlib
import json
import pathlib
import shutil
import subprocess
import tempfile
import zipfile

from build import ROOT, TARGETS, check_kind, sha256
from licenses import generate

EXTENSION = ROOT / 'extension'
BUNDLES = ['out/extension.js', 'out/data.js', 'out/flow.js', 'media/data.css', 'media/flow.css']
TOP_LEVEL = ['README.md', 'CHANGELOG.md', 'LICENSE', 'icon.png']
# vsce renames these inside the package
PACKAGED_NAMES = {'README.md': 'readme.md', 'CHANGELOG.md': 'changelog.md', 'LICENSE': 'LICENSE.txt'}


def git(*args: str) -> str:
    return subprocess.check_output(['git', '-C', str(ROOT), *args], text=True).strip()


def bundle():
    """Production bundles of the extension and webview code, from a clean out/ folder"""
    shutil.rmtree(EXTENSION / 'out', ignore_errors=True)
    subprocess.run(['npm', 'run', '-s', 'typecheck'], cwd=EXTENSION, check=True)
    subprocess.run(['node', 'esbuild.mjs', '--production'], cwd=EXTENSION, check=True)


def stage_package(stage: pathlib.Path, artifact: pathlib.Path, vsix_target: str, package: dict):
    for name in TOP_LEVEL:
        shutil.copy2(ROOT / name, stage / name)
    for name in BUNDLES:
        (stage / name).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(EXTENSION / name, stage / name)
    shutil.copytree(artifact / 'bin', stage / 'bin')
    shutil.copytree(artifact / 'extensions', stage / 'extensions')
    for binary in (stage / 'bin').iterdir():
        binary.chmod(0o755)
    info = json.loads((artifact / 'build.json').read_text())
    notices = generate(stage / 'licenses', vsix_target, info['target'], EXTENSION / 'out' / 'meta.json')
    (stage / 'THIRD-PARTY-NOTICES.md').write_text(notices)
    # A prepared stage has no build step and no development dependencies
    staged = {k: v for k, v in package.items() if k not in ('scripts', 'devDependencies', 'dependencies')}
    (stage / 'package.json').write_text(json.dumps(staged, indent=2) + '\n')


def verify(vsix: pathlib.Path, info: dict, package: dict):
    target = TARGETS[info['vsix_target']]
    with zipfile.ZipFile(vsix) as z:
        names = set(z.namelist())
        manifest = json.loads(z.read('extension/package.json'))
        if (manifest['name'], manifest['publisher'], manifest['version']) != (package['name'], package['publisher'], package['version']):
            raise RuntimeError(f'{vsix.name}: the packaged extension identity differs from package.json')
        for relative, digest in info['files'].items():
            member = f'extension/{relative}'
            if member not in names:
                raise RuntimeError(f'{vsix.name}: {relative} is missing')
            if hashlib.sha256(z.read(member)).hexdigest() != digest:
                raise RuntimeError(f'{vsix.name}: {relative} changed while packaging')
        top = [PACKAGED_NAMES.get(n, n) for n in TOP_LEVEL]
        expected = {f'extension/{n}' for n in [*top, *BUNDLES, 'package.json', 'THIRD-PARTY-NOTICES.md', *info['files']]}
        missing = expected - names
        if missing:
            raise RuntimeError(f'{vsix.name}: missing {sorted(missing)}')
        unexpected = [n for n in names - expected if n.startswith('extension/') and not n.startswith('extension/licenses/')]
        if unexpected:
            raise RuntimeError(f'{vsix.name}: unexpected files {sorted(unexpected)}')
        executables = [n for n in names if n.startswith('extension/bin/') and n.endswith(target.executable)]
        if len(executables) != 1:
            raise RuntimeError(f'{vsix.name}: expected exactly one engine executable')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--artifacts', type=pathlib.Path, required=True)
    parser.add_argument('--out', type=pathlib.Path, required=True)
    parser.add_argument('--target', choices=[*TARGETS, 'all'], default='all')
    args = parser.parse_args()
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    package = json.loads((EXTENSION / 'package.json').read_text())
    commit, dirty = git('rev-parse', 'HEAD'), bool(git('status', '--porcelain'))
    bundle()
    vsce = EXTENSION / 'node_modules' / '.bin' / 'vsce'
    manifest = []
    for vsix_target in TARGETS:
        if args.target not in ('all', vsix_target):
            continue
        artifact = args.artifacts.resolve() / vsix_target
        info = json.loads((artifact / 'build.json').read_text())
        if info['vsix_target'] != vsix_target or info['version'] != package['version']:
            raise RuntimeError(f'{vsix_target}: the build is for {info["vsix_target"]} {info["version"]}, not {package["version"]}; rebuild it')
        for relative, digest in info['files'].items():
            if sha256(artifact / relative) != digest:
                raise RuntimeError(f'{vsix_target}: {relative} differs from its build record')
        for binary in (artifact / 'bin').iterdir():
            check_kind(binary, vsix_target)
        vsix = out / f"{package['name']}-{package['version']}-{vsix_target}.vsix"
        # Staged under ~/.cache: /tmp is a small tmpfs and each stage is over 100 MB
        scratch = pathlib.Path.home() / '.cache' / 'qdf-release' / 'stage'
        scratch.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='qdf-package-', dir=scratch) as directory:
            stage = pathlib.Path(directory)
            stage_package(stage, artifact, vsix_target, package)
            subprocess.run([str(vsce), 'package', '--no-dependencies', '--target', vsix_target, '--out', str(vsix)], cwd=stage, check=True)
        verify(vsix, info, package)
        manifest.append({**info, 'extension_commit': commit, 'extension_dirty': dirty, 'vsix': vsix.name, 'vsix_sha256': sha256(vsix)})
        print(f'Packaged {vsix.name}: {vsix.stat().st_size / 1048576:.1f} MB', flush=True)
    if len({(m['commit'], m['source_sha256']) for m in manifest}) > 1:
        raise RuntimeError('The engine builds come from different source revisions; rebuild them together')
    (out / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    # release.sh runs the validator from beside the manifest
    shutil.copy2(pathlib.Path(__file__).with_name('release-artifacts.py'), out / 'release-artifacts.py')


if __name__ == '__main__':
    main()
