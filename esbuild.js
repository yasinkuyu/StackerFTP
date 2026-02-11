const esbuild = require('esbuild');

async function main() {
    const ctx = await esbuild.context({
        entryPoints: ['src/extension.ts'],
        bundle: true,
        format: 'cjs',
        minify: false,
        sourcemap: !process.argv.includes('--minify'),
        sourcesContent: false,
        platform: 'node',
        target: 'node16.14', // Match VS Code's Node version range
        outfile: 'dist/extension.js',
        external: ['vscode', 'ssh2'],
        logLevel: 'info',
        mainFields: ['module', 'main'],
    });

    if (process.argv.includes('--watch')) {
        await ctx.watch();
    } else {
        await ctx.rebuild();
        await ctx.dispose();
    }
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
