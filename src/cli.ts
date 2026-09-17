import { startDevServer } from './dev-server.ts';
import { buildBrowser } from './browser-build.ts';

const help = `Golem — local project CLI

Usage: ./golem <command>

  help    Show every command (also the default).
  dev     Serve the browser shell at http://127.0.0.1:3000/.
          Stop with Ctrl+C. Uses the local Codex runtime from the browser.
  build   Build the browser shell into dist/.
  doctor  Report local shell and backend readiness.

Requires Node.js >=22.18.0. Commands accept no additional arguments.
Exit codes: 0 success/clean shutdown, 1 unavailable or failed, 2 invalid usage.
`;

const [command = 'help', ...args] = process.argv.slice(2);

if (args.length || !['help', 'dev', 'build', 'doctor'].includes(command)) {
  console.error('Invalid command or arguments. Run ./golem help.');
  process.exitCode = 2;
} else {
  switch (command) {
    case 'help':
      console.log(help);
      break;
    case 'doctor':
      console.log(`Golem shell readiness (Node ${process.version})
Ready: local CLI, HTTP shell, golem-ui browser build and Codex session seam.
Claude integration: not yet connected.
Not implemented: Claude integration and golem-kit init.
No network exposure is enabled; the dev server binds to loopback.`);
      break;
    case 'build':
      try {
        await buildBrowser();
      } catch (error) {
        console.error(`Cannot build Golem browser shell: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
      break;
    case 'dev':
      try {
        const server = await startDevServer();
        const stop = () => {
          server.close((error) => {
            process.removeListener('SIGINT', stop);
            process.removeListener('SIGTERM', stop);
            if (error) {
              console.error(error.message);
              process.exitCode = 1;
            } else {
              console.log('Golem dev server stopped.');
            }
          });
          server.closeAllConnections();
        };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
        console.log('Golem shell: http://127.0.0.1:3000/ (Ctrl+C to stop)');
      } catch (error) {
        console.error(`Cannot start Golem dev server: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
  }
}
