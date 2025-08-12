// split.js
// Node 18+. npm i pdf-lib
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { PDFDocument } = require('pdf-lib');

/* ======= CONFIG ======= */
const INPUT_PDF = 'educational_psychology_theory_and_practice_robert_slavin.pdf';
const OUT_DIR = './pdf-parts';
const MAX_PART_MB = 18;      // target max per part; null to ignore and use FORCE_PARTS
const FORCE_PARTS = null;    // e.g., 2 or 3 for exact halves/thirds; null to auto by MAX_PART_MB
/* ====================== */

const MB = 1024 * 1024;

async function fileSizeMB(fp){ const st = await fsp.stat(fp); return st.size / MB; }
function chunkEven(arr, k){
  const n = arr.length, out = [];
  for (let i = 0; i < k; i++){
    const start = Math.floor(i * n / k);
    const end   = Math.floor((i+1) * n / k);
    out.push(arr.slice(start, end));
  }
  return out.filter(x=>x.length>0);
}
function shortHash(buf){ return crypto.createHash('sha256').update(buf).digest('hex').slice(0,8); }

async function writePart(srcPdf, pageIdxs, outPath){
  const part = await PDFDocument.create();
  const copied = await part.copyPages(srcPdf, pageIdxs);
  copied.forEach(p => part.addPage(p));
  const bytes = await part.save();
  const hash8 = shortHash(bytes);
  await fsp.writeFile(outPath, bytes);
  return { sizeBytes: bytes.length, hash8 };
}

function sortPartsByStartPage(partsMeta){
  partsMeta.sort((a,b) => Math.min(...a.pageIdxs) - Math.min(...b.pageIdxs));
}

async function splitByPlan(srcPdf, plan, baseName){
  await fsp.mkdir(OUT_DIR, { recursive: true });
  const partsMeta = [];
  for (let i = 0; i < plan.length; i++){
    const idxs = plan[i];
    const out = path.join(OUT_DIR, `${baseName}.tmp-${Date.now()}-${i}.pdf`);
    const { sizeBytes, hash8 } = await writePart(srcPdf, idxs, out);
    partsMeta.push({ out, sizeBytes, pageIdxs: idxs, hash8 });
  }
  return partsMeta;
}

function planToPageRanges(parts){
  return parts.map(p => {
    const pages = p.pageIdxs.map(x => x + 1);
    return { start: pages[0], end: pages[pages.length-1] };
  });
}

async function refineOversize(srcPdf, partsMeta, maxBytes, baseName){
  let changed = false;
  for (let i = 0; i < partsMeta.length; i++){
    const p = partsMeta[i];
    if (maxBytes && p.sizeBytes > maxBytes && p.pageIdxs.length > 1){
      const mid = Math.floor(p.pageIdxs.length / 2);
      const a = p.pageIdxs.slice(0, mid);
      const b = p.pageIdxs.slice(mid);

      const leftOut  = path.join(OUT_DIR, `${baseName}.tmp-${Date.now()}-${i}-L.pdf`);
      const rightOut = path.join(OUT_DIR, `${baseName}.tmp-${Date.now()}-${i}-R.pdf`);
      const [leftRes, rightRes] = await Promise.all([
        writePart(srcPdf, a, leftOut),
        writePart(srcPdf, b, rightOut),
      ]);

      try { await fsp.unlink(p.out); } catch {}

      partsMeta.splice(i, 1,
        { out:leftOut,  sizeBytes:leftRes.sizeBytes,  pageIdxs:a, hash8:leftRes.hash8 },
        { out:rightOut, sizeBytes:rightRes.sizeBytes, pageIdxs:b, hash8:rightRes.hash8 }
      );
      changed = true;
      i++; // skip the inserted right part
    }
  }
  return changed;
}

async function relabelOutputs(partsMeta, baseName, totalPages){
  sortPartsByStartPage(partsMeta);
  for (let i = 0; i < partsMeta.length; i++){
    const p = partsMeta[i];
    const finalName = `${baseName}.p${totalPages}.part${String(i+1).padStart(2,'0')}-of-${String(partsMeta.length).padStart(2,'0')}.${p.hash8}.pdf`;
    const finalPath = path.join(OUT_DIR, finalName);
    if (p.out !== finalPath){
      await fsp.rename(p.out, finalPath);
      p.out = finalPath;
    }
  }
}

async function main(){
  if (!fs.existsSync(INPUT_PDF)) { console.error('File not found:', INPUT_PDF); process.exit(1); }
  const base = path.parse(INPUT_PDF).name;
  const totalMB = await fileSizeMB(INPUT_PDF);
  const totalBytes = totalMB * MB;
  console.log(`Input: ${INPUT_PDF} — ${totalMB.toFixed(2)} MB`);

  const srcPdf = await PDFDocument.load(await fsp.readFile(INPUT_PDF));
  const totalPages = srcPdf.getPageCount();
  const allIdxs = Array.from({length: totalPages}, (_,i)=>i);

  let numParts;
  if (FORCE_PARTS && FORCE_PARTS > 0) {
    numParts = Math.min(FORCE_PARTS, totalPages);
  } else if (MAX_PART_MB && totalMB > MAX_PART_MB) {
    numParts = Math.min(Math.ceil(totalMB / MAX_PART_MB), totalPages);
  } else {
    numParts = 1;
  }

  let plan = chunkEven(allIdxs, numParts);
  let parts = await splitByPlan(srcPdf, plan, base);

  if (MAX_PART_MB) {
    const maxBytes = MAX_PART_MB * MB;
    let pass = 0;
    while (parts.some(p=>p.sizeBytes > maxBytes) && pass < 12) {
      pass++;
      console.log(`Refine pass ${pass}…`);
      const changed = await refineOversize(srcPdf, parts, maxBytes, base);
      if (!changed) break;
    }
  }

  await relabelOutputs(parts, base, totalPages);

  console.log('\nOUTPUT PARTS');
  sortPartsByStartPage(parts);
  const ranges = planToPageRanges(parts);
  parts.forEach((p, i) => {
    console.log(
      `Part ${String(i+1).padStart(2,'0')}: ${(p.sizeBytes/MB).toFixed(2)} MB — pages ${ranges[i].start}-${ranges[i].end} — ${path.basename(p.out)}`
    );
  });
}

main().catch(e => { console.error(e); process.exit(1); });
