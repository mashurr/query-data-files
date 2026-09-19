import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const shared = {
    bundle: true,
    minify: production,
    sourcemap: !production,
    logLevel: 'info',
};

const contexts = await Promise.all([
    // Extension host code runs in Node; `vscode` is provided at runtime
    esbuild.context({
        ...shared,
        entryPoints: { extension: 'src/extension.ts' },
        outdir: 'out',
        platform: 'node',
        format: 'cjs',
        target: 'node20',
        external: ['vscode'],
    }),
    // Webview code runs in the editor's browser frame
    esbuild.context({
        ...shared,
        entryPoints: { data: 'webview/data/main.ts' },
        outdir: 'out',
        platform: 'browser',
        format: 'iife',
        target: 'es2022',
    }),
]);

if (watch) {
    await Promise.all(contexts.map(context => context.watch()));
} else {
    await Promise.all(contexts.map(context => context.rebuild()));
    await Promise.all(contexts.map(context => context.dispose()));
}
