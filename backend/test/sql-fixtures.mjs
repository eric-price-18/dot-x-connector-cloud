// Test-only statement splitter: keep SQLite trigger bodies and quoted/commented
// semicolons intact when passing migrations through D1's single-statement API.
export function migrationStatements(sql) {
  const tokens=sql.match(/--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[A-Za-z_][A-Za-z_0-9]*|[\s\S]/g)??[];
  const statements=[];let statement='',head=[],trigger=false,depth=0,meaningful=false;
  for(const token of tokens) {
    statement+=token;
    if(/^\s+$|^--|^\/\*/.test(token))continue;
    meaningful=true;
    if(/^[A-Za-z_][A-Za-z_0-9]*$/.test(token)) {
      const word=token.toUpperCase();if(head.length<3)head.push(word);
      trigger=head[0]==='CREATE'&&(head[1]==='TRIGGER'||(['TEMP','TEMPORARY'].includes(head[1])&&head[2]==='TRIGGER'));
      if(trigger&&(word==='BEGIN'||word==='CASE'))depth++;
      if(trigger&&word==='END')depth--;
    }
    if(token===';'&&(!trigger||depth===0)) {
      statements.push(statement.trim());statement='';head=[];trigger=false;depth=0;meaningful=false;
    }
  }
  if(meaningful)throw new Error('Incomplete SQL migration statement');
  return statements;
}
