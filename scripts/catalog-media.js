import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
const root=path.resolve('uploads/catalog');
const headers={'User-Agent':'TraverCatalog/1.0 (reference travel catalog; Wikimedia attribution retained)'};
const plain=s=>(s||'').replace(/<[^>]*>/g,'').replace(/&amp;/g,'&').trim();
const escape=s=>String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function json(url){const r=await fetch(url,{headers,signal:AbortSignal.timeout(15000)});if(!r.ok)throw new Error('Photo metadata unavailable');return r.json();}
async function api(params){return json('https://en.wikipedia.org/w/api.php?'+new URLSearchParams({action:'query',format:'json',formatversion:'2',...params}));}
export async function importPhotos(tour,used){
 await fs.mkdir(root,{recursive:true});const cache=path.join(root,tour._id+'.json');
 try{const saved=JSON.parse(await fs.readFile(cache,'utf8'));if(saved.photos.length && saved.photos.every(p=>!used.has(p.title))) {for(const p of saved.photos){await fs.access(path.join(root,p.file));used.add(p.title);}return saved;}}catch{}
 const article=await api({titles:tour.wiki,redirects:'1',prop:'pageimages|images|coordinates',piprop:'name',imlimit:'40',colimit:'1'});
 const page=article.query?.pages?.[0];if(!page||page.missing)throw new Error('Destination article unavailable');
 const titles=[page.pageimage,...(page.images||[]).map(x=>x.title?.replace(/^File:/,''))].filter(Boolean);
 const candidates=[...new Set(titles)].filter(t=>/\.jpe?g$/i.test(t)&&!/(logo|flag|map|portrait|coat.of.arms|locator|emblem|icon)/i.test(t)&&!used.has(t)).slice(0,24);
 if(!candidates.length)throw new Error('No distinct destination photos');
 const meta=await api({titles:candidates.map(t=>'File:'+t).join('|'),prop:'imageinfo',iiprop:'url|extmetadata',iiurlwidth:'1200'});
 const items=meta.query?.pages||[];const photos=[];
 // Prefer the article's lead image, then its other photos; never reuse images between tours.
 items.sort((a,b)=>candidates.indexOf(a.title?.replace(/^File:/,''))-candidates.indexOf(b.title?.replace(/^File:/,'')));
 for(const p of items){
  if(photos.length===3)break;const info=p.imageinfo?.[0],e=info?.extmetadata;if(!info||!e)continue;
  const license=plain(e.LicenseShortName?.value);if(!/^(CC BY(?:-SA)? [\d.]+|CC0|Public domain)$/i.test(license))continue;
  const title=p.title.replace(/^File:/,'');if(used.has(title))continue;
  const url=info.thumburl||info.url;if(new URL(url).hostname!=='upload.wikimedia.org')continue;
  try{
   const r=await fetch(url,{headers,signal:AbortSignal.timeout(20000)});if(!r.ok||!r.headers.get('content-type')?.startsWith('image/'))continue;
   if(Number(r.headers.get('content-length'))>20000000)continue;
   const bytes=Buffer.from(await r.arrayBuffer());if(bytes.length>20000000)continue;
   const file=crypto.createHash('sha256').update(title).digest('hex').slice(0,24)+'.jpg';
   await fs.writeFile(path.join(root,file),await sharp(bytes,{limitInputPixels:40000000}).rotate().resize({width:1200,withoutEnlargement:true}).jpeg({quality:82}).toBuffer());
   photos.push({title,file,author:plain(e.Artist?.value),credit:plain(e.Credit?.value),license,licenseUrl:e.LicenseUrl?.value||'https://commons.wikimedia.org/wiki/Commons:Licensing',source:info.descriptionurl,changes:'Resized, JPEG encoded; app may crop for display.'});used.add(title);
  }catch{console.info(`Photo download skipped for ${tour._id}`);}
 }
 if(!photos.length)throw new Error('No licensed photos downloaded');
 const result={tourId:tour._id,name:tour.name,article:'https://en.wikipedia.org/wiki/'+encodeURIComponent(page.title),photos};
 await fs.writeFile(cache,JSON.stringify(result,null,2));return result;
}
export async function writeCredits(){
 await fs.mkdir(root,{recursive:true});const records=[];
 for(const file of await fs.readdir(root)){if(!/^tour-\d+\.json$/.test(file))continue;try{records.push(JSON.parse(await fs.readFile(path.join(root,file),'utf8')));}catch{}}
 const body=records.map(r=>`<section id="${escape(r.tourId)}"><h2>${escape(r.name)}</h2>${r.photos.map(p=>`<figure><img src="${escape(p.file)}" width="320" loading="lazy" alt="${escape(p.title)}"><figcaption>${escape(p.title)} — ${escape(p.author)}. ${escape(p.credit)} <a href="${escape(p.source)}">Nguồn ảnh</a> · <a href="${escape(p.licenseUrl)}">${escape(p.license)}</a>. ${escape(p.changes)}</figcaption></figure>`).join('')}</section>`).join('');
 await fs.writeFile(path.join(root,'credits.html'),`<!doctype html><html lang="vi"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Nguồn ảnh Traver</title><style>body{font:16px system-ui;max-width:850px;margin:auto;padding:20px}img{max-width:100%;height:auto}figure{margin:24px 0}figcaption{line-height:1.6}</style><h1>Nguồn ảnh Traver</h1><p>Ảnh cảnh quan tham khảo của điểm đến, không xác nhận dịch vụ hoặc lịch trình của nhà cung cấp.</p>${body}</html>`);
}
