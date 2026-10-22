export const MEDIA_ZOOM_MESSAGE = "pupitre:media-zoom";

const script = `(() => {
  if (window.parent === window) return;
  const send = (kind, element) => {
    const src = element.currentSrc || element.getAttribute("src") || "";
    if (!src.startsWith("data:" + kind + "/")) return false;
    if (kind === "video") element.pause();
    window.parent.postMessage({
      type: "${MEDIA_ZOOM_MESSAGE}",
      kind,
      src,
      alt: element.getAttribute("alt") || element.getAttribute("title") || "",
      time: kind === "video" ? element.currentTime : 0,
    }, "*");
    return true;
  };
  const style = document.createElement("style");
  style.textContent = "img[src^='data:image/']:not(a img){cursor:zoom-in}"
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
  button.addEventListener("click", () => { if (hovered && send("video", hovered)) hide(); });
  document.addEventListener("dblclick", (event) => {
    const video = event.target.closest && event.target.closest("video");
    if (video && send("video", video)) event.preventDefault();
  });
  document.addEventListener("click", (event) => {
    const image = event.target.closest && event.target.closest("img");
    if (!image || image.closest("a, button") || image.naturalWidth < 48) return;
    if (send("image", image)) event.preventDefault();
  });
})();`;

export function withMediaZoom(html: string): string {
  const tag = `<script>${script}</script>`;
  const end = html.search(/<\/body\s*>(?![\s\S]*<\/body\s*>)/i);
  return end === -1 ? html + tag : html.slice(0, end) + tag + html.slice(end);
}
