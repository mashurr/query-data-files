import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

function git(cwd: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        cp.execFile('git', args, { cwd, maxBuffer: 16 << 20, windowsHide: true }, (err, stdout, stderr) => {
            if (err) { reject(new Error(stderr.trim() || err.message)); } else { resolve(stdout); }
        });
    });
}

export interface Revision { rev: string; label: string }

/** Asks which earlier version of a file to compare with; undefined when cancelled */
export async function pickRevision(file: string): Promise<Revision | undefined> {
    const dir = path.dirname(file);
    let root: string;
    try {
        root = (await git(dir, ['rev-parse', '--show-toplevel'])).trim();
    } catch {
        throw new Error('This file isn\'t in a git repository, so there are no earlier versions to compare with.');
    }
    const relative = path.relative(root, file).split(path.sep).join('/');
    const log = await git(root, ['log', '-n', '50', '--format=%H%x1f%h%x1f%ar%x1f%s', '--', relative]).catch(() => '');
    const commits = log.split('\n').filter(Boolean).map(line => {
        const [hash, short, ago, subject] = line.split('\x1f');
        return { hash, short, ago, subject };
    });
    if (!commits.length) {
        throw new Error('This file has no commits yet, so there is no earlier version to compare with.');
    }
    type Item = vscode.QuickPickItem & { rev?: string };
    const items: Item[] = commits.map(c => ({ label: `$(git-commit) ${c.subject}`, description: `${c.short} · ${c.ago}`, rev: c.hash }));
    items.push({ label: '$(edit) Another revision…', description: 'A branch, tag or expression like HEAD~3' });
    const picked = await vscode.window.showQuickPick(items, { title: `Compare ${path.basename(file)} with`, placeHolder: 'Choose an earlier version', matchOnDescription: true });
    if (!picked) { return undefined; }
    if (picked.rev) {
        const commit = commits.find(c => c.hash === picked.rev)!;
        return { rev: `${commit.hash}:${relative}`, label: `${commit.short} (${commit.ago})` };
    }
    const typed = await vscode.window.showInputBox({ title: 'Compare with revision', prompt: 'A branch, tag, commit or expression like HEAD~3', validateInput: v => /^[^-\s][^\s]*$/.test(v) ? undefined : 'Enter a revision' });
    return typed ? { rev: `${typed}:${relative}`, label: typed } : undefined;
}

/** Writes `rev` (e.g. a1b2c3:data/orders.csv) of the file into `target` */
export function extract(file: string, rev: string, target: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = cp.spawn('git', ['show', rev], { cwd: path.dirname(file), windowsHide: true });
        const out = fs.createWriteStream(target);
        let stderr = '';
        child.stderr.on('data', d => { stderr += d; });
        child.stdout.pipe(out);
        child.on('error', reject);
        child.on('close', code => {
            out.close();
            if (code === 0) { resolve(); } else { reject(new Error(stderr.trim() || `git show exited with ${code}`)); }
        });
    });
}
