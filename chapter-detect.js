
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
function wordToNum(w){ return WORD_TO_NUM[w.toLowerCase()] ?? null; }
function romanToNum(str){
  const map={I:1,V:5,X:10,L:50,C:100,D:500,M:1000};
  let v=0,prev=0;
  for(let i=str.length-1;i>=0;i--){
    const n=map[str[i].toUpperCase()]||0;
    v += n<prev ? -n : n; prev=n;
  }
  return v||null;
}

/* ------------------------------------------------------------------ */
/* 2.  Line reconstruction                                            */
/* ------------------------------------------------------------------ */
function buildLines(tc){
  const tolY=2;
  const buckets=new Map();
  for(const it of tc.items){
    const tr=it.transform||[1,0,0,1,0,0];
    const x=tr[4]||0;
    const y=tr[5]||0;
    const fs=Math.max(Math.abs(tr[0]||0),Math.abs(tr[3]||0))||10;
    const key=Math.round(y/tolY)*tolY;
    (buckets.get(key)??[]).push({x,y,fs,str:it.str||''});
    buckets.set(key,buckets.get(key));
  }
  const lines=[...buckets.entries()].map(([y,arr])=>{
    arr.sort((a,b)=>a.x-b.x);
    const text=clean(arr.map(a=>a.str).join(' '));
    return {
      y,
      text,
      fontMax:Math.max(...arr.map(a=>a.fs)),
      x0:arr[0].x, x1:arr[arr.length-1].x
    };
  });
  lines.sort((a,b)=>a.y-b.y);               // bottom → top in PDF coords
  return lines;
}

/* ------------------------------------------------------------------ */
/* 3.  Page model builder                                             */
/* ------------------------------------------------------------------ */
function isTOC(txt){
  const t=norm(txt);
  const dots=/\.{3,}/.test(t);
  const manyCh=(t.match(/chapter\s+\d+/g)||[]).length >= 4;
  return /table of contents|contents/i.test(t) || (dots&&manyCh);
}
function isSummaryPage(txt){
  return /\b(summary|key terms|self[-\s]?assessment|chapter review)\b/i.test(txt);
}

function buildPageModels(pages){
  const pagesLines=pages.map(p=>buildLines(p.tc));

  // find repeating headers / footers (simple heuristic)
  const topFreq=new Map(), botFreq=new Map();
  pagesLines.forEach(lines=>{
    if(!lines.length) return;
    const ys=lines.map(l=>l.y);
    const min=Math.min(...ys), max=Math.max(...ys), span=Math.max(1,max-min);
    lines.forEach(l=>{
      const key=norm(l.text);
      if(key.length<4) return;
      const pos=(l.y-min)/span;
      if(pos>0.85) topFreq.set(key,(topFreq.get(key)||0)+1);
      if(pos<0.15) botFreq.set(key,(botFreq.get(key)||0)+1);
    });
  });
  const topHeaders=new Set([...topFreq.entries()].filter(([,c])=>c>=6).map(([t])=>t));
  const botHeaders=new Set([...botFreq.entries()].filter(([,c])=>c>=6).map(([t])=>t));

  return pages.map((p,idx)=>{
    let lines=pagesLines[idx].filter(l=>{
      const t=norm(l.text);
      return !topHeaders.has(t) && !botHeaders.has(t) && t!==String(idx+1);
    });

    const fonts=lines.map(l=>l.fontMax).sort((a,b)=>a-b);
    const f75=fonts[Math.floor(0.75*(fonts.length-1))]||10;
    const f90=fonts[Math.floor(0.90*(fonts.length-1))]||10;

    const ys=lines.map(l=>l.y);
    const minY=Math.min(...ys,0), maxY=Math.max(...ys,1), span=Math.max(1,maxY-minY);
    lines.forEach(l=>l.topFrac=(l.y-minY)/span);

    return {
      idx,
      txt:p.txt,
      lines,
      font75:f75,
      font90:f90,
      toc:isTOC(p.txt),
      summary:isSummaryPage(p.txt)
    };
  });
}

/* ------------------------------------------------------------------ */
/* 4.  Heading detection on a page                                    */
/* ------------------------------------------------------------------ */
const CH_WORD = /\bchapter\b/i;
const NUM_TOKEN = /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|[IVXLCDM]{1,7})\b/;

function numFromToken(tok){
  if(/^\d+$/.test(tok)) return +tok;
  if(WORD_TO_NUM[tok.toLowerCase()]) return WORD_TO_NUM[tok.toLowerCase()];
  if(/^[IVXLCDM]+$/i.test(tok))      return romanToNum(tok);
  return null;
}

function headingCandidate(line,nextLine){
  /* Combines “CHAPTER” + “TWO” split headings */
  if(norm(line.text)==='chapter' && nextLine && NUM_TOKEN.test(nextLine.text)){
    return {text: line.text+' '+nextLine.text, font: nextLine.fontMax, topFrac: line.topFrac};
  }
  if(CH_WORD.test(line.text)) return {text: line.text, font: line.fontMax, topFrac: line.topFrac};
  return null;
}

function evaluateHeading(h, chapterNum, page){
  let score=0;
  if(!h) return -Infinity;

  // must contain correct number
  const m = h.text.match(NUM_TOKEN);
  const numTok = m && m[1];
  const n = numTok ? numFromToken(numTok) : null;
  if(n===chapterNum) score+=4;
  else return -Infinity; // reject wrong number altogether

  // presence of word “chapter”
  if(CH_WORD.test(h.text)) score+=2;

  // typography
  if(h.font>=page.font90) score+=2;
  else if(h.font>=page.font75) score+=1;

  // near top
  if(h.topFrac>=0.70) score+=2;

  return score;
}

/* ------------------------------------------------------------------ */
/* 5.  Main detector (sequential)                                     */
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
  let cursor = 0;                        // where to start scanning for next chapter

  for(let ch=1; ch<=expectedChapters.length; ch++){
    const tokensExp = tokenize(expectedChapters[ch-1]);
    let found = null;

    for(let p=cursor; p<models.length; p++){
      const page=models[p];
      if(page.toc || page.summary) continue;

      let bestOnPage = {score:-Infinity, title:null};

      for(let i=0;i<page.lines.length;i++){
        const cand = headingCandidate(page.lines[i], page.lines[i+1]);
        if(!cand) continue;

        const score = evaluateHeading(cand, ch, page);
        if(score>bestOnPage.score){
          // rough title = text after the matched token(s)
          const titlePart = cand.text.replace(/^\s*chapter\s+\b.*?\b\s*/i,'');
          const sim = jaccard(tokenize(titlePart), tokensExp);
          const title = titlePart || expectedChapters[ch-1];
          bestOnPage = {score: score + (sim>=0.4?2:0), title};
        }
      }

      if(bestOnPage.score>=5){
        found = {number:ch, start:p+1, title:clean(bestOnPage.title)};
        cursor = p + 3;          // enforce at least 3 pages gap
        break;
      }
    }

    if(found) results.push(found);
  }

  /* page ranges */
  for(let i=0;i<results.length;i++){
    results[i].end = (i<results.length-1 ? results[i+1].start-1 : pages.length);
  }

  /* report */
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
/* 6.  CLI                                                            */
/* ------------------------------------------------------------------ */
const pdfFile = process.argv[2] || 'educational_psychology_theory_and_practice_robert_slavin.pdf';
if(!fs.existsSync(pdfFile)){
  console.error('File not found:', pdfFile);
  process.exit(1);
}
detectChapters(pdfFile).catch(err=>console.error(err));
