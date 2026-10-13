import {getDatabasePool} from '../src/modules/database/client.ts';
import {backfillProfileIndex,recoverDeferredProfiles} from '../src/modules/enrichment/profile-index.ts';
const args=process.argv.slice(2);
if(args.some(a=>!['--apply','--recover-deferred'].includes(a)))throw new Error('Use --apply and optionally --recover-deferred.');
const pool=getDatabasePool();
try {
 if(!args.includes('--apply')) {
  const {rows:[r]}=await pool.query(`SELECT count(*)::integer AS remaining FROM import_rows r WHERE NOT EXISTS(SELECT 1 FROM profile_indexed_rows i WHERE i.import_row_id=r.import_row_id)`);
  console.log(JSON.stringify({mode:'preview',...r}));
 }else{
  const index=await backfillProfileIndex(pool);
  const recovery=args.includes('--recover-deferred')?await recoverDeferredProfiles(pool):null;
  console.log(JSON.stringify({mode:'applied',...index,recovery}));
 }
}finally{await pool.end();}
