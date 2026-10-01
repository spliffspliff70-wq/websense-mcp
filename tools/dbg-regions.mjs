import { regionTree } from '../src/snapshot.js';
const mk = (i, tag, attrs, p) => { const r = { i, tag }; if (attrs) { r.attrs = attrs; r.attrNames = Object.keys(attrs); } if (p != null) r.p = p; return r; };
const snapBare = { elements: [
  mk(0,'html',null,null), mk(1,'body',{id:'default'},0), mk(2,'div',{class:'page'},1),
  mk(3,'article',{class:'product_pod'},2), mk(4,'span',{'aria-label':'inner'},3), mk(9,'span',{'aria-label':'meta'},3),
  mk(5,'article',{class:'product_pod'},2), mk(6,'span',{'aria-label':'inner'},5), mk(10,'span',{'aria-label':'meta'},5),
  mk(7,'article',{class:'product_pod'},2), mk(8,'span',{'aria-label':'inner'},7), mk(11,'span',{'aria-label':'meta'},7),
] };
const cases = [
  ['semantic only', { className: false, classFallback: false }],
  ['class forced', { className: true, classFallback: false }],
  ['DEFAULT (auto)', {}],
];
for (const [tag, o] of cases) {
  const r = regionTree(snapBare, { ...o, debug: true });
  console.log(`--- ${tag}: regions=${r.regions} named=${r.named}`);
  console.log(r.outline || '(empty)');
  if (tag === 'class forced') {
    for (const e of r.debug) if (e.kids > 0) console.log(`     i=${e.i} ${e.tag} kids=${e.kids} place=${e.place} region=${e.region} src=${e.src} name=${e.name || '-'}`);
  }
}
