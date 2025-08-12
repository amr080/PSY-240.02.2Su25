#!/usr/bin/env node
/*  Robust chapter detector – v3 (Layout-aware, sequential, strict)
    npm i pdf-parse
*/

const fs  = require('fs');
const pdf = require('pdf-parse');

/* ------------------------------------------------------------------ */
/* 0.  Config                                                         */
/* ------------------------------------------------------------------ */
const expectedChapters = [
  'Educational Psychology: A Foundation for Teaching',
  'Cognitive Development',
  'Social, Moral, and Emotional Development',
  'Student Diversity',
  'Behavioral and Social Theories of Learning',
  'Cognitive Theories of Learning',
  'The Direct Instruction Lesson',
  'Student-Centered and Constructivist Approaches to Instruction',
  'Grouping, Differentiation, and Technology',
  'Motivating Students to Learn',
  'Effective Learning Environments',
  'Learners with Exceptionalities'
];

const MIN_PAGES_PER_CHAPTER = 5; // Enforce a reasonable gap
const JUNK_TITLE_WORDS = /\b(chapter outline|continued|key terms|summary|objectives|learning|assessing|student)\b/i;

const WORD_TO_NUM = {
  one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,
  eleven:11,twelve:12
};

const STOP = new Set(['the','a','an','of','and','to','for','in','on','with',
                      'at','by','is','are','as','from','into','about','between',
                      'through','without','over','under']);

/* ------------------------------------------------------------------ */
/* 1.  Helpers                                                        */
/* ------------------------------------------------------------------ */
const clean = s => (s||'').replace(/\s+/g,' ').trim();
const norm  = s => clean(s).toLowerCase();
const tokenize = s => norm(s).split(/[^a-z0-9]+/).filter(w=>w&&!STOP.has(w));

function jaccard(a,b){
  const A=new Set(a), B=new Set(b);
  const inter=[...A].filter(x=>B.has(x)).length;
  return inter / (new Set([...A,...B]).size || 1);
}
function romanToNum(str){
  const map={I:1,V:5,X:10,L:50,C:100,D:500,M:1000};
  let v=0,prev=0;
  for(let i=str.length-1;i>=0;i--){
    const n=map[str[i].toUpperCase()]||0;
    v += n<prev ? -n : n; prev=n;
  }
  return v||null;
}
function numFromToken(tok){
  if(!tok) return null;
  const t = tok.toLowerCase();
  if(/^\d+$/.test(t)) return +t;
  if(WORD_TO_NUM[t]) return WORD_TO_NUM[t];
  if(/^[ivxlcdm]+$/i.test(tok)) return romanToNum(tok);
  return null;
}

/* ------------------------------------------------------------------ */
/* 2.  Line & Page Model Reconstruction                               */
/* ------------------------------------------------------------------ */
function buildLines(tc){
  const tolY=2;
  const buckets=new Map();
  for(const it of tc.items){
    const tr=it.transform||[1,0,0,1,0,0];
    const x=tr[4]||0, y=tr[5]||0;
    const fs=Math.max(Math.abs(tr[0]||0),Math.abs(tr[3]||0))||10;
    const key=Math.round(y/tolY)*tolY;
    const arr = buckets.get(key) || [];
    arr.push({x,y,fs,str:it.str||''});
    buckets.set(key, arr);
  }
  const lines=[...buckets.entries()].map(([y,arr])=>{
    arr.sort((a,b)=>a.x-b.x);
    return {
      y,
      text:clean(arr.map(a=>a.str).join(' ')),
      fontMax:Math.max(...arr.map(a=>a.fs)),
      x0: arr.length ? arr[0].x : 0
    };
  });
  lines.sort((a,b)=>a.y-b.y);
  return lines;
}

function buildPageModels(pages){
  const pagesLines=pages.map(p=>buildLines(p.tc));
  return pages.map((p,idx)=>{
    const lines=pagesLines[idx];
    const fonts=lines.map(l=>l.fontMax).sort((a,b)=>a-b);
    const f75=fonts[Math.floor(0.75*(fonts.length-1))]||10;
    const f90=fonts[Math.floor(0.90*(fonts.length-1))]||10;
    const ys=lines.map(l=>l.y);
    const minY=Math.min(...ys,0), maxY=Math.max(...ys,1), span=Math.max(1,maxY-minY);
    lines.forEach(l=>l.topFrac=(l.y-minY)/span);

    return {
      idx,
      lines,
      font75:f75,
      font90:f90,
      toc: /\b(table of contents|contents)\b/i.test(p.txt) && /\.{3,}/.test(p.txt),
      summary: /\b(summary|key terms|chapter review)\b/i.test(p.txt)
    };
  });
}

/* ------------------------------------------------------------------ */
/* 3.  Heading & Title Evaluation                                     */
/* ------------------------------------------------------------------ */
const RE_HEADING = /^\s*C\s*H\s*A\s*P\s*T\s*E\s*R\s*(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|[IVXLCDM]{1,7})\s*$/i;

function findTitleOnPage(page, headingLineIndex) {
    // Look for a title in the next 1-4 lines below the heading
    for (let i = headingLineIndex + 1; i < Math.min(headingLineIndex + 5, page.lines.length); i++) {
        const line = page.lines[i];
        // A title line must have a large font and not be junk
        if (line.fontMax >= page.font75 && line.text.length > 5 && !JUNK_TITLE_WORDS.test(line.text)) {
            return line.text;
        }
    }
    return null;
}

function evaluateCandidate(page, lineIndex, chapterNum, expectedTitleTokens) {
    const line = page.lines[lineIndex];
    const match = line.text.match(RE_HEADING);

    // 1. Must be a valid heading line
    if (!match) return { score: -Infinity };
    const foundNum = numFromToken(match[1]);
    if (foundNum !== chapterNum) return { score: -Infinity };

    let score = 5; // Base score for a valid heading match

    // 2. Score typography and position
    if (line.fontMax >= page.font90) score += 2;
    if (line.topFrac >= 0.65) score += 2;

    // 3. Find and score the title
    const title = findTitleOnPage(page, lineIndex);
    if (title) {
        score += 2; // Bonus for finding any title
        const similarity = jaccard(tokenize(title), expectedTitleTokens);
        if (similarity >= 0.5) score += 3; // High similarity bonus
    } else {
        score -= 4; // Penalize heavily if no title is found
    }

    return { score, title: title || `Chapter ${chapterNum}` };
}

/* ------------------------------------------------------------------ */
/* 4.  Main Detection Loop                                            */
/* ------------------------------------------------------------------ */
async function detectChapters(pdfPath){
  const raw = fs.readFileSync(pdfPath);
  const pages = [];
  await pdf(raw, {
    pagerender: pd => pd.getTextContent().then(tc=>{
      pages.push({tc, txt: clean(tc.items.map(i=>i.str).join(' '))});
      return '';
    })
  });

  const models = buildPageModels(pages);
  const results = [];
  let cursor = 0; // Where to start scanning for the next chapter

  for(let ch=1; ch<=expectedChapters.length; ch++){
    const tokensExp = tokenize(expectedChapters[ch-1]);
    let found = null;

    // Scan from the cursor to the end of the book
    for(let p=cursor; p<models.length; p++){
      const page=models[p];
      if(page.toc || page.summary) continue;

      let bestOnPage = {score:-Infinity, title:null};

      for(let i=0; i<page.lines.length; i++){
        const res = evaluateCandidate(page, i, ch, tokensExp);
        if(res.score > bestOnPage.score) {
            bestOnPage = res;
        }
      }

      // If we found a high-quality match on this page, lock it in.
      if(bestOnPage.score >= 8){
        found = {number:ch, start:p+1, title:clean(bestOnPage.title)};
        cursor = p + MIN_PAGES_PER_CHAPTER; // Advance cursor
        break; // Stop searching for this chapter
      }
    }
    if(found) results.push(found);
  }

  // Calculate page ranges
  for(let i=0;i<results.length;i++){
    results[i].end = (i<results.length-1 ? results[i+1].start-1 : pages.length);
  }

  // Final Report
  console.log(`Total pages: ${pages.length}\n`);
  console.log('DETECTED CHAPTERS');
  console.log('=================');
  results.forEach(r=>console.log(`Chapter ${r.number}: pages ${r.start}-${r.end} — ${r.title}`));

  const missing = [];
  for(let i=1;i<=expectedChapters.length;i++){
    if(!results.some(r=>r.number===i)) missing.push(i);
  }
  if(missing.length){
    console.log(`\nMISSING CHAPTERS: ${missing.join(', ')}`);
  }
}

/* ------------------------------------------------------------------ */
/* 5.  CLI Runner                                                     */
/* ------------------------------------------------------------------ */
const pdfFile = process.argv[2] || 'educational_psychology_theory_and_practice_robert_slavin.pdf';
if(!fs.existsSync(pdfFile)){
  console.error('File not found:', pdfFile);
  process.exit(1);
}
detectChapters(pdfFile).catch(err=>console.error(err));
