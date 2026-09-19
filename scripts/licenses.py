#!/usr/bin/env python3
"""Collects the license texts of everything a package ships: DuckDB and its extensions,
the Rust crates in the engine, the JavaScript bundled into the webviews and the runtime
libraries linked into the engine."""
import json
import pathlib
import re
import shutil
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[1]
LICENSE_NAMES = ('LICENSE', 'LICENCE', 'COPYING', 'NOTICE', 'COPYRIGHT')


def license_files(directory: pathlib.Path) -> list[pathlib.Path]:
    return [f for f in directory.iterdir() if f.is_file() and f.name.upper().startswith(LICENSE_NAMES)]


def generate(destination: pathlib.Path, vsix_target: str, rust_target: str, meta: pathlib.Path) -> str:
    """Writes license texts under `destination` and returns THIRD-PARTY-NOTICES.md"""
    destination.mkdir(parents=True, exist_ok=True)
    sections = []

    shutil.copytree(ROOT / 'licenses', destination / 'duckdb', dirs_exist_ok=True, ignore=shutil.ignore_patterns('README.md', 'crates'))
    sections.append('## DuckDB\n\n'
                    '- DuckDB 1.5.5 (MIT), with the third-party code it contains: `licenses/duckdb/duckdb`\n'
                    '- sqlite_scanner extension (MIT), which embeds SQLite (public domain): `licenses/duckdb/duckdb-sqlite`\n'
                    '- excel extension (MIT): `licenses/duckdb/duckdb-excel`')

    metadata = json.loads(subprocess.check_output(
        ['cargo', 'metadata', '--locked', '--format-version', '1', '--filter-platform', rust_target.split('.')[0]], cwd=ROOT / 'engine'))
    resolved = {n['id'] for n in metadata['resolve']['nodes']}
    crates = []
    for package in sorted(metadata['packages'], key=lambda p: (p['name'], p['version'])):
        if package['source'] is None or package['id'] not in resolved:
            continue
        name = f"{package['name']}-{package['version']}"
        files = license_files(pathlib.Path(package['manifest_path']).parent)
        # A few crates publish without their license file; copies from their repositories are kept here
        vendored = ROOT / 'licenses' / 'crates' / package['name']
        if not files and vendored.is_dir():
            files = license_files(vendored)
        if not files:
            raise RuntimeError(f'License text missing for the {name} crate')
        for file in files:
            target = destination / 'rust' / name / file.name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(file, target)
        crates.append(f"- {name}: {package['license']}")
    sections.append('## Rust crates in the engine\n\nTexts in `licenses/rust/`.\n\n' + '\n'.join(crates))

    inputs = json.loads(meta.read_text())['inputs']
    packages = set()
    for name in inputs:
        parts = pathlib.Path(name).parts
        if 'node_modules' in parts:
            i = parts.index('node_modules')
            packages.add(pathlib.Path(*parts[:i + (3 if parts[i + 1].startswith('@') else 2)]))
    js = []
    for directory in sorted(packages):
        directory = ROOT / 'extension' / directory
        package = json.loads((directory / 'package.json').read_text())
        name = f"{package['name'].replace('/', '-')}-{package['version']}"
        files = license_files(directory)
        if not files:
            raise RuntimeError(f'License text missing for the {name} package')
        for file in files:
            target = destination / 'javascript' / name / file.name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(file, target)
        js.append(f"- {package['name']} {package['version']}: {package.get('license', 'see its license file')}")
    sections.append('## JavaScript bundled into the extension\n\nTexts in `licenses/javascript/`.\n\n' + '\n'.join(js))

    runtime = []
    sysroot = pathlib.Path(subprocess.check_output(['rustc', '--print', 'sysroot'], text=True, cwd=ROOT / 'engine').strip())
    rust_notice = sysroot / 'share/doc/rust/COPYRIGHT-library.html'
    if not rust_notice.is_file():
        raise RuntimeError('Rust standard library copyright notice missing')
    (destination / 'runtime').mkdir(exist_ok=True)
    shutil.copy2(rust_notice, destination / 'runtime' / 'rust-standard-library.html')
    runtime.append('- Rust standard library (MIT or Apache-2.0): `licenses/runtime/rust-standard-library.html`')
    if vsix_target.startswith('win32'):
        zig = pathlib.Path(re.search(r'\.lib_dir = "([^"]+)"', subprocess.check_output(['zig', 'env'], text=True)).group(1))
        shutil.copy2(zig / 'libc/mingw/COPYING', destination / 'runtime' / 'mingw-w64-COPYING')
        runtime.append('- MinGW-w64 runtime (zlib-style and public domain): `licenses/runtime/mingw-w64-COPYING`')
    sections.append('## Runtime libraries in the engine\n\n' + '\n'.join(runtime))

    return '# Third-party notices\n\nQuery Data Files ships the following third-party software. Their license texts are in the `licenses` folder.\n\n' + '\n\n'.join(sections) + '\n'


if __name__ == '__main__':
    import sys
    print(generate(pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3], pathlib.Path(sys.argv[4])))
