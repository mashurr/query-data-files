#!/usr/bin/env python3
"""Builds the engine for each platform and gathers what ships beside it: DuckDB's
prebuilt library and its SQLite and Excel extensions. DuckDB itself is never compiled.

    scripts/build.py all              release builds of every target into the scratch folder
    scripts/build.py win32-x64        one target
    scripts/build.py --dev            a debug build for this machine, installed into extension/
"""
import argparse
import gzip
import hashlib
import json
import os
import pathlib
import platform
import shutil
import subprocess
import sys
import urllib.request
import zipfile
from dataclasses import dataclass

ROOT = pathlib.Path(__file__).resolve().parents[1]
ENGINE = ROOT / 'engine'
EXTENSION = ROOT / 'extension'
DUCKDB = 'v1.5.5'
TOOLCHAIN = {'rust': '1.98.0', 'zig': '0.16.0', 'cargo-zigbuild': '0.23.4'}
EXTENSIONS = ['sqlite_scanner', 'excel']
DOWNLOADS = pathlib.Path.home() / '.cache' / 'qdf-release' / 'downloads'


@dataclass(frozen=True)
class Target:
    rust: str
    library_zip: str
    library: str
    platform: str
    # macOS ships one library for both CPUs; each package keeps only its own
    thin: str | None = None

    @property
    def executable(self) -> str:
        return 'qdf-engine.exe' if 'windows' in self.rust else 'qdf-engine'


TARGETS = {
    # glibc 2.25 is the newest version DuckDB's own Linux library needs
    'linux-x64': Target('x86_64-unknown-linux-gnu.2.25', 'libduckdb-linux-amd64.zip', 'libduckdb.so', 'linux_amd64'),
    'linux-arm64': Target('aarch64-unknown-linux-gnu.2.25', 'libduckdb-linux-arm64.zip', 'libduckdb.so', 'linux_arm64'),
    'darwin-x64': Target('x86_64-apple-darwin', 'libduckdb-osx-universal.zip', 'libduckdb.dylib', 'osx_amd64', 'x86_64'),
    'darwin-arm64': Target('aarch64-apple-darwin', 'libduckdb-osx-universal.zip', 'libduckdb.dylib', 'osx_arm64', 'arm64'),
    'win32-x64': Target('x86_64-pc-windows-gnu', 'libduckdb-windows-amd64.zip', 'duckdb.dll', 'windows_amd64'),
    'win32-arm64': Target('aarch64-pc-windows-gnullvm', 'libduckdb-windows-arm64.zip', 'duckdb.dll', 'windows_arm64'),
}

# Checked on every build; a change upstream stops the build instead of shipping something new
SHA256 = {
    'libduckdb-linux-amd64.zip': '1fb8ce388157d84a25abe685a8a2520bf00c00321821968e4bb398fd766e7abb',
    'libduckdb-linux-arm64.zip': 'abe4f6f005ee0b448a058322f4263584b4bd1b6faf7ab4637b79eeaf978f8e9c',
    'libduckdb-osx-universal.zip': '7b5b8915cc382d0708636fe6385c0cdad5a61c9ff8ba2638b3e2141640783155',
    'libduckdb-windows-amd64.zip': '8375eb1fcf2212e8a0817950354815d4dde9dd383c2d9fa7b8975b71e278c1bd',
    'libduckdb-windows-arm64.zip': '006f8df62957f640a100d673432a5b6f9a7002662822a4567ed06a436ee1d801',
    'linux_amd64-excel.duckdb_extension.gz': '74a67c4a8b2571bf2933a5bdc3ac01712906bf4a4b5e651346702e941ea3581c',
    'linux_amd64-sqlite_scanner.duckdb_extension.gz': '01292812092200c2d0b76324df9568d336ddaa5a198e7cc8fed124e84088e14e',
    'linux_arm64-excel.duckdb_extension.gz': '039c1e3461b66569db9c93527a60e8c25dc0a90aa3a81b28467c3a4c32d49e18',
    'linux_arm64-sqlite_scanner.duckdb_extension.gz': '59e3d3197d8767e51c3df10157d4423f4df58f97d85ffe0eb0bf752325f76641',
    'osx_amd64-excel.duckdb_extension.gz': '1d2bd5aed588f49a9b6a571a258749b555b72ab1993957fb3cb0cb7b0e47714f',
    'osx_amd64-sqlite_scanner.duckdb_extension.gz': '1b96e4ac03a4394708166f75236614a80fd1f9ab810fb3f35ea7aa5a9a833501',
    'osx_arm64-excel.duckdb_extension.gz': '1167dd3d36ad7747413655d8f415c425132b8970ddcfb3bb08e12ddb58364938',
    'osx_arm64-sqlite_scanner.duckdb_extension.gz': 'd7514249b0cce24bb63856b4c752a889ef2f739c6fd821109988e4e13afd7058',
    'windows_amd64-excel.duckdb_extension.gz': 'a50d8bbb8d37b036ea7366206c082dc8b90f4f902f7d5799f028bc07d41a995d',
    'windows_amd64-sqlite_scanner.duckdb_extension.gz': 'b6139c7f3b40a1b3ba5ef605e4590eda4a55e4e8deefc8182a2644e4a5797f69',
    'windows_arm64-excel.duckdb_extension.gz': '83f4ddb879e05d4afe41b329d00d53e71cb0b853539dd669dab6504acbb012e1',
    'windows_arm64-sqlite_scanner.duckdb_extension.gz': 'e2f0d414feb7597540e843c29201b7a8dd427b24286a30ba31b47e0e012ece16',
}

# chrono (via arrow) links CoreFoundation for local time zones, which the engine never
# uses. Without an Apple SDK the linker only needs these symbols listed; every Mac has
# the real framework at run time.
CORE_FOUNDATION_STUB = """--- !tapi-tbd
tbd-version: 4
targets: [ x86_64-macos, arm64-macos ]
install-name: '/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation'
current-version: 1971
exports:
  - targets: [ x86_64-macos, arm64-macos ]
    symbols: [ _CFRelease, _CFStringGetBytes, _CFStringGetCStringPtr, _CFStringGetLength,
               _CFTimeZoneCopySystem, _CFTimeZoneGetName, _CFTimeZoneResetSystem ]
...
"""

# What `file` must report for each package's executable and library
FILE_KINDS = {
    'linux-x64': ['ELF', 'x86-64'], 'linux-arm64': ['ELF', 'aarch64'],
    'darwin-x64': ['Mach-O', 'x86_64'], 'darwin-arm64': ['Mach-O', 'arm64'],
    'win32-x64': ['PE32+', 'x86-64'], 'win32-arm64': ['PE32+', 'ARM64'],
}


def sha256(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(*args, **kwargs) -> str:
    return subprocess.check_output(args, text=True, **kwargs).strip()


def download(name: str, url: str) -> pathlib.Path:
    """A pinned download, cached between builds"""
    DOWNLOADS.mkdir(parents=True, exist_ok=True)
    path = DOWNLOADS / name
    if not path.exists():
        print(f'Downloading {url}', flush=True)
        partial = path.with_suffix(path.suffix + '.part')
        with urllib.request.urlopen(url) as response, partial.open('wb') as out:
            shutil.copyfileobj(response, out)
        partial.rename(path)
    if sha256(path) != SHA256[name]:
        path.unlink()
        sys.exit(f'{name} does not match its pinned checksum; it was deleted, check upstream before retrying')
    return path


def library(target: Target, into: pathlib.Path) -> pathlib.Path:
    """DuckDB's prebuilt library for a target, plus the headers the Rust crate links with"""
    archive = download(target.library_zip, f'https://github.com/duckdb/duckdb/releases/download/{DUCKDB}/{target.library_zip}')
    into.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as z:
        for member in z.namelist():
            if member.endswith(('.h', '.lib')) or member == target.library:
                z.extract(member, into)
    lib = into / target.library
    if target.thin:
        thin = into / f'{target.library}.thin'
        subprocess.run(['llvm-lipo', str(lib), '-thin', target.thin, '-output', str(thin)], check=True)
        thin.replace(lib)
    return lib


def extensions(target: Target, into: pathlib.Path) -> list[pathlib.Path]:
    """The bundled DuckDB extensions, laid out the way DuckDB's extension_directory expects"""
    folder = into / DUCKDB / target.platform
    folder.mkdir(parents=True, exist_ok=True)
    out = []
    for name in EXTENSIONS:
        archive = download(f'{target.platform}-{name}.duckdb_extension.gz',
                           f'https://extensions.duckdb.org/{DUCKDB}/{target.platform}/{name}.duckdb_extension.gz')
        path = folder / f'{name}.duckdb_extension'
        with gzip.open(archive) as src, path.open('wb') as dst:
            shutil.copyfileobj(src, dst)
        out.append(path)
    return out


def check_kind(path: pathlib.Path, vsix_target: str):
    description = run('file', '-b', str(path))
    if not all(word.lower() in description.lower() for word in FILE_KINDS[vsix_target]):
        raise RuntimeError(f'{path.name} is not a {vsix_target} binary: {description}')


def toolchain() -> dict:
    versions = {
        'rust': run('rustc', '--version', cwd=ENGINE),
        'zig': run('zig', 'version'),
        'cargo-zigbuild': run('cargo-zigbuild', '--version'),
    }
    for key, expected in TOOLCHAIN.items():
        if expected not in versions[key]:
            sys.exit(f'{key}: expected {expected}, found {versions[key]}')
    return versions


def build_target(vsix_target: str, scratch: pathlib.Path, versions: dict, jobs: str):
    target = TARGETS[vsix_target]
    artifact = scratch / 'artifacts' / vsix_target
    shutil.rmtree(artifact, ignore_errors=True)
    lib_dir = scratch / 'libduckdb' / vsix_target
    lib = library(target, lib_dir)

    rust_target = target.rust
    env = dict(os.environ, CARGO_TARGET_DIR=str(scratch / 'intermediates'), CARGO_BUILD_JOBS=jobs,
               DUCKDB_LIB_DIR=str(lib_dir), DUCKDB_INCLUDE_DIR=str(lib_dir),
               ZIG_GLOBAL_CACHE_DIR=str(scratch / 'zig-cache'), CARGO_ZIGBUILD_CACHE_DIR=str(scratch / 'zigbuild-cache'))
    if 'apple' in rust_target:
        frameworks = scratch / 'macos-stubs'
        (frameworks / 'CoreFoundation.framework').mkdir(parents=True, exist_ok=True)
        (frameworks / 'CoreFoundation.framework' / 'CoreFoundation.tbd').write_text(CORE_FOUNDATION_STUB)
        env[f'CARGO_TARGET_{rust_target.upper().replace("-", "_")}_RUSTFLAGS'] = f'-C link-arg=-F{frameworks}'

    log = scratch / f'{vsix_target}.log'
    print(f'Building {vsix_target}; log: {log}', flush=True)
    with log.open('w') as stream:
        result = subprocess.run(['cargo', 'zigbuild', '--locked', '--release', '--target', rust_target],
                                cwd=ENGINE, env=env, stdout=stream, stderr=subprocess.STDOUT)
    if result.returncode:
        sys.exit(f'Build failed: {vsix_target}; see {log}')

    bin_dir = artifact / 'bin'
    bin_dir.mkdir(parents=True)
    built = scratch / 'intermediates' / rust_target.split('.')[0] / 'release' / target.executable
    shutil.copy2(built, bin_dir / target.executable)
    shutil.copy2(lib, bin_dir / target.library)
    exts = extensions(target, artifact / 'extensions')
    for path in [bin_dir / target.executable, bin_dir / target.library]:
        check_kind(path, vsix_target)

    files = {str(p.relative_to(artifact)): sha256(p) for p in [bin_dir / target.executable, bin_dir / target.library, *exts]}
    commit = run('git', 'rev-parse', 'HEAD', cwd=ROOT)
    info = {
        'vsix_target': vsix_target,
        'target': rust_target,
        'version': json.loads((EXTENSION / 'package.json').read_text())['version'],
        'duckdb': DUCKDB,
        'commit': commit,
        'dirty': bool(run('git', 'status', '--porcelain', cwd=ROOT)),
        'source_sha256': source_hash(),
        'toolchain': versions,
        'files': files,
    }
    (artifact / 'build.json').write_text(json.dumps(info, indent=2) + '\n')
    size = sum((artifact / f).stat().st_size for f in files)
    print(f'Built {vsix_target}: {size / 1048576:.1f} MB', flush=True)


def source_hash() -> str:
    digest = hashlib.sha256()
    for path in sorted([*ENGINE.glob('src/**/*.rs'), ENGINE / 'Cargo.toml', ENGINE / 'Cargo.lock', ENGINE / '.cargo' / 'config.toml']):
        digest.update(str(path.relative_to(ROOT)).encode())
        digest.update(path.read_bytes())
    return digest.hexdigest()


def dev_build():
    """Builds for this machine and installs the engine where a development VS Code finds it"""
    host = {('Linux', 'x86_64'): 'linux-x64', ('Linux', 'aarch64'): 'linux-arm64'}.get((platform.system(), platform.machine()))
    if not host:
        sys.exit('--dev supports Linux hosts; other platforms use the packaged builds')
    target = TARGETS[host]
    scratch = pathlib.Path.home() / '.cache' / 'qdf-release' / 'dev'
    lib_dir = scratch / 'libduckdb'
    lib = library(target, lib_dir)
    env = dict(os.environ, DUCKDB_LIB_DIR=str(lib_dir), DUCKDB_INCLUDE_DIR=str(lib_dir))
    subprocess.run(['cargo', 'build'], cwd=ENGINE, env=env, check=True)
    bin_dir = EXTENSION / 'bin'
    shutil.rmtree(bin_dir, ignore_errors=True)
    bin_dir.mkdir()
    shutil.copy2(ENGINE / 'target' / 'debug' / target.executable, bin_dir / target.executable)
    shutil.copy2(lib, bin_dir / target.library)
    shutil.rmtree(EXTENSION / 'extensions', ignore_errors=True)
    extensions(target, EXTENSION / 'extensions')
    print(f'Installed a debug engine for {host} into {bin_dir}')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('target', nargs='?', choices=[*TARGETS, 'all'])
    parser.add_argument('--dev', action='store_true', help='debug build for this machine, installed into extension/')
    parser.add_argument('--scratch', type=pathlib.Path, default=pathlib.Path.home() / '.cache' / 'qdf-release')
    parser.add_argument('--jobs', default='4')
    args = parser.parse_args()
    if args.dev:
        dev_build()
        return
    if not args.target:
        parser.error('choose a target, all, or --dev')
    versions = toolchain()
    scratch = args.scratch.resolve()
    for vsix_target in TARGETS:
        if args.target in ('all', vsix_target):
            build_target(vsix_target, scratch, versions, args.jobs)


if __name__ == '__main__':
    main()
