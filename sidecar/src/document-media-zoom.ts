export const MEDIA_ZOOM_MESSAGE = "pupitre:media-zoom";

const script = `(() => {
  if (window.parent === window) return;
  const sourceOf = (element, kind) => {
    const src = element.currentSrc || element.getAttribute("src") || "";
    if (src.startsWith("data:" + kind + "/")) return src;
    if (kind !== "image" || !src.startsWith("blob:") || !element.complete) return null;
    try {
      const canvas = document.createElement("canvas");
      canvas.width = element.naturalWidth;
      canvas.height = element.naturalHeight;
      canvas.getContext("2d").drawImage(element, 0, 0);
      return canvas.toDataURL("image/png");
    } catch { return null; }
  };
  const itemOf = (element) => {
    const kind = element.tagName === "VIDEO" ? "video" : "image";
    if (kind === "image" && (element.closest("a, button") || element.naturalWidth < 48)) return null;
    const src = sourceOf(element, kind);
    if (!src) return null;
    const alt = element.getAttribute("alt") || element.getAttribute("title") || "";
    return { kind, src, alt, time: kind === "video" ? element.currentTime : 0 };
  };
  const send = (element) => {
    const items = [];
    let index = -1;
    for (const candidate of document.querySelectorAll("img, video")) {
      const item = itemOf(candidate);
      if (!item) continue;
      if (candidate === element) index = items.length;
      items.push(item);
    }
    if (index === -1) return false;
    if (element.tagName === "VIDEO") element.pause();
    window.parent.postMessage({ type: "${MEDIA_ZOOM_MESSAGE}", items, index }, "*");
    return true;
  };
  const style = document.createElement("style");
  style.textContent = "img:is([src^='data:image/'],[src^='blob:']):not(a img){cursor:zoom-in}"
    + ".pupitre-media-zoom{position:fixed;z-index:2147483647;display:none;padding:4px 10px;"
    + "border:0;border-radius:6px;background:rgb(0 0 0/72%);color:#fff;font:600 12px/1.4 system-ui,sans-serif;cursor:pointer}";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "pupitre-media-zoom";
  button.textContent = "⤢ Agrandir";
  let hovered = null;
  const hide = () => { hovered = null; button.style.display = "none"; };
  const showOver = (video) => {
    const rect = video.getBoundingClientRect();
    hovered = video;
    button.style.display = "block";
    button.style.top = Math.max(4, rect.top + 8) + "px";
    button.style.left = Math.max(4, rect.right - button.offsetWidth - 8) + "px";
  };
  const mount = () => {
    document.head.append(style);
    document.body.append(button);
  };
  if (document.body) mount(); else document.addEventListener("DOMContentLoaded", mount);
  document.addEventListener("pointerover", (event) => {
    if (event.target === button) return;
    const video = event.target.closest && event.target.closest("video");
    if (video) showOver(video); else hide();
  });
  window.addEventListener("scroll", hide, true);
  button.addEventListener("click", () => { if (hovered && send(hovered)) hide(); });
  document.addEventListener("dblclick", (event) => {
    const video = event.target.closest && event.target.closest("video");
    if (video && send(video)) event.preventDefault();
  });
  document.addEventListener("click", (event) => {
    const image = event.target.closest && event.target.closest("img");
    if (image && send(image)) event.preventDefault();
  });
})();`;

export function withMediaZoom(html: string): string {
  const tag = `<script>${script}</script>`;
  const end = html.search(/<\/body\s*>(?![\s\S]*<\/body\s*>)/i);
  return end === -1 ? html + tag : html.slice(0, end) + tag + html.slice(end);
}
