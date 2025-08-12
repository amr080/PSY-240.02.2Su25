// chapter-detect.js

// node chapter-detect.js

// chapter-detect.js
//
// usage:  node chapter-detect.js  [book.pdf]
// requires:  npm install pdfjs-dist

const fs        = require('fs');
const path      = require('path');
const pdfjsLib  = require('pdfjs-dist/legacy/build/pdf.js');

// ---------------------------------------------------------------------------
// 1.  Expected chapters from syllabus
// ---------------------------------------------------------------------------
const expectedChapters = [
  'Educational Psychology: A Foundation for Teaching',
  'Cognitive Development',
  'Social, Moral, and Emotional Development',
  'Student Diversity',
  'Behavioral Theories of Learning',
  'Information Processing and Cognitive Theories of Learning',
  'The Effective Lesson',
  'Student-Centered and Constructivist Approaches to Instruction',
  'Accommodating Instruction to Meet Individual Needs',
  'Motivating Students to Learn',
  'Effective Learning Environments',
  'Learners with Exceptionalities'
];

// ---------------------------------------------------------------------------
// 2.  Helpers
// ---------------------------------------------------------------------------
const WORD_TO_NUM = {
  one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,
  eleven:11,twelve:12
};

function clean(text){
  return text.replace(/\s+/g,' ').trim();
}

// Two regex flavours:  digit form  |  word form
const CHAPTER_DIGIT_RE =
  /\bchapter\s+(\d{1,2})[\s.:_-]{0,6}([a-z][\w\s,:;'’()-]{5,120})/i;
const CHAPTER_WORD_RE  =
  /\bchapter\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)[\s.:_-]{0,6}([a-z][\w\s,:;'’()-]{5,120})/i;

// ---------------------------------------------------------------------------
// 3.  Main routine
// ---------------------------------------------------------------------------
async function detectChapters(pdfPath){
  const data      = new Uint8Array(fs.readFileSync(pdfPath));
  const pdfDoc    = await pdfjsLib.getDocument({data}).promise;
  const numPages  = pdfDoc.numPages;

  const found = [];   // {number, title, page}

  for(let p=1; p<=numPages; p++){
    const page      = await pdfDoc.getPage(p);
    const textItems = await page.getTextContent();
    const pageText  = clean(textItems.items.map(i=>i.str).join(' '));

    let m = pageText.match(CHAPTER_DIGIT_RE);
    if(!m) m = pageText.match(CHAPTER_WORD_RE);
    if(!m) continue;

    const num  = m[1] ? parseInt(m[1],10) : WORD_TO_NUM[m[2].toLowerCase()];
    const title= clean(m[2] || m[3] || '');

    if(num>=1 && num<=expectedChapters.length &&
        !found.some(c=>c.number===num)){
      found.push({number:num,title,page:p});
    }
  }

  // Sort & build page ranges -------------------------------------------------
  found.sort((a,b)=>a.number-b.number);
  const ranges = found.map((c,i)=>({
      ...c,
      startPage : c.page,
      endPage   : i<found.length-1 ? found[i+1].page-1 : pdfDoc.numPages
  }));

  // -------------------------------------------------------------------------
  //  Output
  // -------------------------------------------------------------------------
  console.log(`Total pages: ${pdfDoc.numPages}\n`);
  console.log('DETECTED CHAPTERS');
  console.log('=================');
  ranges.forEach(c=>{
    console.log(`Chapter ${c.number}: pages ${c.startPage}-${c.endPage}  —  ${c.title}`);
  });

  console.log('\nEXPECTED CHAPTERS');
  console.log('=================');
  expectedChapters.forEach((t,i)=>{
    console.log(`Chapter ${i+1}: ${t}`);
  });
}

// ---------------------------------------------------------------------------
// 4.  CLI
// ---------------------------------------------------------------------------
const pdfFile = process.argv[2] || 'educational_psychology_theory_and_practice_robert_slavin.pdf';
if(!fs.existsSync(pdfFile)){
  console.error(`File not found: ${pdfFile}`);
  console.error('Usage: node chapter-detect.js  <pdf-path>');
  process.exit(1);
}

console.log(`Analyzing: ${path.basename(pdfFile)}\n`);
detectChapters(pdfFile).catch(err=>{
  console.error('Error:',err.message || err);
});
