'use strict';
// Rules & permits: Michigan ORV law in plain English. Written from the DNR's ORV pages and the
// Off-Road Vehicle Act (MCL 324.81101+); checked Oct 2026. Update LAWS_CHECKED when re-checked.

const LAWS_CHECKED = 'Oct 2026';
const SRC = {
  permits: 'https://www.michigan.gov/dnr/things-to-do/orv-riding/permits-and-requirements',
  faq: 'https://www.michigan.gov/dnr/faqs/motorized-recreation/orv',
  ages: 'https://www.michigan.gov/dnr/things-to-do/orv-riding/rules/age-restrictions',
  buy: 'https://www.michigan.gov/dnrlicenses',
  ops: 'https://www.legislature.mi.gov/Laws/MCL?objectName=mcl-324-81133',
  roads: 'https://www.legislature.mi.gov/Laws/MCL?objectName=mcl-324-81131',
  owi: 'https://www.legislature.mi.gov/Laws/MCL?objectName=mcl-324-81134',
  deer: 'https://www.michigan.gov/dnr/managing-resources/laws/regulations/deer/season-dates-and-bag-limits',
};
const src = (k, label) => `<a href="${SRC[k]}" target="_blank" rel="noopener">${label}</a>`;

function lawsHtml() {
  const bike = rig === 24, sxs = rig >= 64;
  const sec = (title, body, open) => `<details class="grp law"${open ? ' open' : ''}><summary>${title}</summary>${body}</details>`;
  let html = `<h3>Rules &amp; permits</h3>
    <p class="hint">Michigan ORV law in plain English${rig ? `, with what matters most for your ${esc(machineName())}` : ''}. Not legal advice. Laws change, so check the sources at the bottom before a big trip.</p>`;

  html += sec('Permits you need', `<ul class="law-list">
    <li><b>ORV license: $26.25.</b> Needed on state forest roads, national forest roads and county roads open to ORVs, and on frozen lakes.</li>
    <li><b>ORV trail permit: $10 more ($36.25 total).</b> Needed on DNR-designated trails, routes and scramble areas. The permit doesn't work without the license.</li>
    <li><b>Both run April 1 to March 31.</b> Buy them online (${src('buy', 'Michigan.gov/DNRLicenses')}; the sticker is mailed in 10–15 days), in the DNR Hunt Fish app, or at a license agent.</li>
    <li><b>Out-of-state riders</b> need the same license and permit. A Michigan title isn't required for non-residents.</li>
    <li><b>Most trailhead parking lots</b> need a Recreation Passport on the truck.</li>
    <li><b>Riding only on your own land</b> needs neither.</li></ul>`, true);

  html += sec('Gear &amp; machine', `<ul class="law-list">
    <li><b>DOT-approved helmet and eye protection</b> for the driver <i>and</i> every passenger.${sxs ? '' : ''}</li>
    <li class="${sxs ? 'law-you' : ''}"><b>Side-by-side exception:</b> no helmet needed if your seat belt is fastened <i>and</i> the roof itself meets DOT crash-helmet standards. A regular roof or roll cage doesn't count. If you're not sure yours is rated, wear the helmet.</li>
    <li><b>Spark-arrester muffler</b> (U.S. Forest Service approved), working the whole time.</li>
    <li><b>Sound limit: 94 dB</b> (stationary test) for machines built after 1986.</li>
    <li><b>Lights:</b> headlight and taillight on from half an hour after sunset to half an hour before sunrise, plus a brake light brighter than the taillight. On roads, lights are on at all times.</li>
    <li><b>Passengers</b> only if the machine was built to carry them.</li></ul>`, sxs || bike);

  html += sec('Where you can ride', `<ul class="law-list">
    <li><b>DNR trail types:</b> motorcycle trails (24"), ORV/ATV trails (50"), and ORV routes (72" and wider). It's illegal to take a machine wider than 50" on a forest trail. This map already hides what yours can't use.</li>
    <li><b>State forest roads</b> marked open to ORVs, and national forest roads shown open on the Forest Service map (they have open dates).</li>
    <li><b>County roads only where the county or township has passed an ordinance.</b> Turn on <b>County roads open to ORVs</b> in Layers to see each county's reported status, and call the county sheriff to confirm before riding a road. Where it's allowed: far right, with traffic, single file, <b>25 mph max</b>, lights on.</li>
    <li><b>Never on M- or US- highways,</b> except posted ORV connector routes.</li>
    <li><b>Not in streams, rivers, wetlands or swamps</b> except over a bridge or culvert. Not off the trail in state parks, game areas or recreation areas.</li>
    <li><b>Private land</b> only with the owner's written permission.</li></ul>`);

  html += sec('Riding rules', `<ul class="law-list">
    <li><b>No posted speed limit on trails:</b> ride at a speed that's reasonable for conditions. 25 mph max on roads open to ORVs.</li>
    <li><b>Near houses:</b> crawl speed within 100 feet of a dwelling (except on DNR forest roads/trails and ORV-legal roads).</li>
    <li class="law-you"><b>November firearm deer season (Nov 15–30):</b> no riding on land open to public hunting from 7–11 a.m. and 2–5 p.m. There are exceptions, like getting to a hunting camp or hauling out a deer at 5 mph.</li>
    <li><b>Guns and bows:</b> guns unloaded and in a case; bows unstrung or cased.</li>
    <li><b>Alcohol:</b> 0.08 is drunk, same as driving. Open containers must be sealed or packed away in a closed compartment or case.</li>
    <li><b>Frozen lakes:</b> crawl speed within 100 feet of people, shanties or skating areas.</li>
    <li><b>Winter:</b> ORVs can ride in snowmobile season, but stay off groomed snowmobile trails.</li>
    <li>No chasing animals, no littering, and keep right on two-way trails.</li></ul>`);

  html += sec('Kids &amp; young riders', `<ul class="law-list">
    <li><b>Under 16:</b> must pass an ORV safety course, carry the certificate, and ride with an adult watching them directly.</li>
    <li><b>Under 10:</b> no 4-wheel ATVs (except farm work on private land). <b>Under 16:</b> no 3-wheelers.</li>
    <li><b>Under 12:</b> can't cross roads or ride on roads at all. 12 and up may cross at a right angle with adult supervision and the certificate.</li>
    <li><b>Under 18 on a road:</b> needs a driver's license, or a parent supervising plus the safety certificate.</li>
    <li><b>Helmets:</b> required for under-16s even on private land.</li></ul>`);

  html += sec('In an emergency', `<ul class="law-list">
    <li><b>No signal? Try texting 911.</b> A text can get out on a signal too weak for a call.</li>
    <li>Use <b>SOS</b> in this app to send your exact location, and tell someone your plan before you lose service.</li></ul>`);

  html += `<p class="hint law-src">Sources (checked ${LAWS_CHECKED}): ${src('permits', 'DNR permits &amp; requirements')} · ${src('faq', 'DNR ORV FAQs')} · ${src('ages', 'DNR age rules')} ·
    ${src('ops', 'MCL 324.81133 (operating rules)')} · ${src('roads', 'MCL 324.81131 (roads)')} · ${src('owi', 'MCL 324.81134 (alcohol)')}</p>`;
  return html;
}

function showLaws() {
  $('#sheet-body').onclick = null;
  $('#sheet-body').innerHTML = lawsHtml();
  openSheet('#sheet');
}
window.showLaws = showLaws;
$('#btn-laws').addEventListener('click', showLaws);
