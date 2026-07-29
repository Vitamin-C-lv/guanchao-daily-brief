import fs from 'node:fs';
for (const edition of ['daily','weekly']) { const p=`content/writer-packets/${edition}-latest.json`; if (!fs.existsSync(p)) continue; const x=JSON.parse(fs.readFileSync(p)); if (!x.writerPacketId || !Array.isArray(x.facts) || new Set(x.facts.map(f=>f.factId)).size!==x.facts.length) throw new Error(`${edition} packet fact lineage invalid`); }
console.log('writer packets valid');
