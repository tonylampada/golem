import { startDevServer } from './dev-server.ts';
import { execFileSync } from 'node:child_process';

const help = `Golem — local project CLI

Usage: ./golem <command>

  help    Show every command (also the default).
  dev     Serve the browser shell at http://127.0.0.1:3000/.
          Stop with Ctrl+C. No agent runtime is connected.
  build   Build the browser shell into dist/ (via pnpm build).
  doctor  Report local shell readiness without agents or network access.

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
Ready: local CLI, HTTP shell and golem-ui browser build.
Not implemented: agent runtime and golem-kit init.
No agent executables or network access are required for this check.`);
      break;
    case 'build':
      try {
        execFileSync('pnpm', ['build'], { stdio: 'inherit' });
      } catch {
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
