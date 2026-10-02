// Local test infrastructure only. SQLite supplies complete statement boundaries,
// including trigger bodies, quoted semicolons and CASE ... END expressions.
export function* migrationStatements(parser,source) {
  let remaining=source;
  while(true) {
    remaining=remaining.replace(/^(?:\s|;|--[^\r\n]*(?:\r?\n|$)|\/\*[\s\S]*?\*\/)+/,'');
    if(!remaining)return;
    const statement=parser.prepare(remaining),sql=statement.sourceSQL;
    if(!sql||!remaining.startsWith(sql))throw Error('MIGRATION_STATEMENT_BOUNDARY_REQUIRED');
    statement.run(); // Later statements are parsed against the resulting schema.
    yield sql;
    remaining=remaining.slice(sql.length);
  }
}
