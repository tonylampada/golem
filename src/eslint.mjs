import babelParser from '@babel/eslint-parser'

// Storage and database clients. Extend with `drivers: [...golemDrivers, 'my-driver']`.
export const golemDrivers = [
  'pg', 'postgres', 'mysql', 'mysql2', 'sqlite', 'sqlite3', 'better-sqlite3', 'node:sqlite', '@libsql/client',
  'mongodb', 'mongoose', 'redis', 'ioredis', '@prisma/client', 'drizzle-orm', 'knex', 'kysely', 'typeorm', 'sequelize',
]

// Shared architectural lint for Golem apps. Pass `false` for a boundary to disable it.
export default function golem({ server = 'src/server', persistence = 'src/server/persistence', drivers = golemDrivers, serverModules = ['golem-kit/server'] } = {}) {
  const driverRule = drivers ? [{
    name: drivers,
    message: `Storage drivers belong in persistence adapters${persistence ? ` under ${persistence}/` : ''}.`,
  }] : []
  const serverRule = server ? [{
    name: serverModules,
    message: `Server-only modules belong under ${server}/.`,
  }, {
    regex: '^node:',
    message: `Node built-ins are server-only; use them under ${server}/.`,
  }, {
    // ponytail: matches relative specifiers by directory name, not resolved paths; aliases are not checked.
    regex: `^\\.\\.?/(.*/)?${escape(server.split('/').pop())}(/|$)`,
    message: `Browser and domain code cannot import backend modules from ${server}/.`,
  }] : []
  const restrict = (rules) => {
    const patterns = rules.filter((rule) => rule.regex || rule.name?.length).map(({ name, ...rule }) => name ? { group: name.map(exact), ...rule } : rule)
    return { 'no-restricted-imports': patterns.length ? ['error', { patterns }] : 'off' }
  }
  return [
    { name: 'golem/ignores', ignores: ['dist/', '.golem/'] },
    parser('golem/typescript', ['**/*.{ts,mts,cts}'], ['typescript']),
    parser('golem/tsx', ['**/*.{js,mjs,jsx,tsx}'], ['typescript', 'jsx']),
    { name: 'golem/boundaries', files: ['src/**'], rules: restrict([...driverRule, ...serverRule]) },
    ...(server ? [{ name: 'golem/server', files: [`${server}/**`], rules: restrict(driverRule) }] : []),
    ...(persistence ? [{ name: 'golem/persistence', files: [`${persistence}/**`], rules: restrict([]) }] : []),
  ]
}

// Babel parses TypeScript syntax without type checking; the TypeScript compiler still owns types.
function parser(name, files, plugins) {
  return {
    name, files,
    languageOptions: { parser: babelParser, parserOptions: { requireConfigFile: false, babelOptions: { babelrc: false, configFile: false, parserOpts: { plugins } } } },
  }
}

function escape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// gitignore-style group entries: match the package root and its subpaths exactly.
function exact(name) {
  return `/${name.replace(/[*?[\]!]/g, '\\$&')}`
}
