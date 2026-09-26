/* Ekstraksi teks materi kuliah (PDF / PPTX / TXT) di browser, per halaman/slide.
   Library dimuat saat dibutuhkan saja supaya halaman tetap ringan. */
(function () {
  const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
  const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const JSZIP = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
  const loaded = {};

  function loadScript(src) {
    if (!loaded[src]) {
      loaded[src] = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('Gagal memuat pustaka pembaca file'));
        document.head.appendChild(s);
      });
    }
    return loaded[src];
  }

  async function fromPdf(file) {
    await loadScript(PDFJS);
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    const doc = await window.pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    const pages = [];
    for (let i = 1; i <= Math.min(doc.numPages, 150); i++) {
      const content = await (await doc.getPage(i)).getTextContent();
      pages.push({ page: i, text: content.items.map(it => it.str).join(' ') });
    }
    return pages;
  }

  async function fromPptx(file) {
    await loadScript(JSZIP);
    const zip = await window.JSZip.loadAsync(file);
    const slides = Object.keys(zip.files)
      .filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));
    const pages = [];
    for (const name of slides) {
      const xml = await zip.file(name).async('string');
      const text = (xml.match(/<a:t>([^<]*)<\/a:t>/g) || []).map(t => t.replace(/<\/?a:t>/g, '')).join(' ');
      pages.push({ page: parseInt(name.match(/\d+/)[0]), text });
    }
    return pages;
  }

  async function fromText(file) {
    const text = await file.text();
    // Pecah teks polos per ~1500 karakter supaya tetap ada "halaman" untuk rujukan
    const pages = [];
    for (let i = 0; i < text.length; i += 1500) pages.push({ page: pages.length + 1, text: text.slice(i, i + 1500) });
    return pages;
  }

  window.extractMaterial = async function (file) {
    const name = file.name.toLowerCase();
    let pages;
    if (name.endsWith('.pdf')) pages = await fromPdf(file);
    else if (name.endsWith('.pptx')) pages = await fromPptx(file);
    else if (name.endsWith('.txt') || name.endsWith('.md')) pages = await fromText(file);
    else throw new Error('Format belum didukung. Gunakan PDF, PPTX, atau TXT.');
    pages = pages.map(p => ({ page: p.page, text: p.text.replace(/\s+/g, ' ').trim() })).filter(p => p.text.length > 20);
    if (!pages.length) throw new Error('Tidak ada teks yang bisa dibaca. File hasil scan (gambar) belum didukung.');
    return pages;
  };
})();
