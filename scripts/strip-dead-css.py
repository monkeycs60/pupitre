"""
Retire de ui/src/styles/ les règles qui ne peuvent plus s'appliquer.

Une règle est morte quand chacun de ses sélecteurs contient au moins une classe
qu'aucune source de ui/src ne produit : les compounds d'un sélecteur doivent
tous matcher, donc une seule classe morte suffit à le neutraliser. Dans une
liste `.a, .b`, seuls les sélecteurs morts tombent — la règle survit par `.b`.

Les classes composées à l'exécution (`is-${status}`) sont épargnées : la liste
des préfixes dynamiques est relue depuis les sources à chaque exécution.
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STYLES = ROOT / "ui/src/styles"


def sources() -> str:
    parts = []
    for path in (ROOT / "ui/src").rglob("*"):
        if path.suffix in {".ts", ".tsx"} and "styles" not in path.parts:
            parts.append(path.read_text(encoding="utf8"))
    return "\n".join(parts)


def dead_classes(src: str) -> set[str]:
    dynamic = sorted(set(re.findall(r"([a-z][a-z0-9-]*-)\$\{", src)))
    declared: set[str] = set()
    for sheet in STYLES.glob("*.css"):
        declared |= set(re.findall(r"\.([a-z][a-z0-9-]{2,})", sheet.read_text(encoding="utf8")))
    return {
        name for name in declared
        if name not in src and not any(name.startswith(p) for p in dynamic)
    }


def split_prelude(prelude: str) -> tuple[str, str]:
    """
    Sépare ce qui précède la règle (commentaires, blancs) de ses sélecteurs.

    Indispensable : un commentaire comme « table de diff, numéros de ligne »
    contient des virgules, et le confondre avec une liste de sélecteurs le
    coupe en deux.
    """
    end = 0
    for match in re.finditer(r"/\*.*?\*/", prelude, flags=re.S):
        end = match.end()
    return prelude[:end], prelude[end:]


def split_top_level(selector: str) -> list[str]:
    """Découpe une liste de sélecteurs sur les virgules hors parenthèses."""
    out, depth, current = [], 0, ""
    for char in selector:
        if char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
        if char == "," and depth == 0:
            out.append(current)
            current = ""
        else:
            current += char
    out.append(current)
    return out


def strip(css: str, dead: set[str]) -> tuple[str, int]:
    out, removed, i = [], 0, 0
    while i < len(css):
        brace = css.find("{", i)
        if brace == -1:
            out.append(css[i:])
            break

        prelude = css[i:brace]
        # Corps de la règle, en suivant l'imbrication (@media, @supports…).
        depth, j = 1, brace + 1
        while j < len(css) and depth:
            if css[j] == "{":
                depth += 1
            elif css[j] == "}":
                depth -= 1
            j += 1
        body = css[brace + 1:j - 1]

        head = prelude.strip()
        if head.startswith("@") and "{" in body + "{":
            # Bloc conditionnel : on traite son contenu, on le garde s'il reste
            # quelque chose dedans.
            inner, inner_removed = strip(body, dead)
            removed += inner_removed
            if inner.strip():
                out.append(prelude + "{" + inner + "}")
            else:
                out.append(leading_whitespace(prelude))
            i = j
            continue

        comments, selector_text = split_prelude(prelude)
        selectors = split_top_level(selector_text)
        kept = [s for s in selectors
                if not (set(re.findall(r"\.([a-z][a-z0-9-]{2,})", s)) & dead)]

        if not kept:
            removed += 1
            # Les commentaires qui précédaient la règle sont conservés : savoir
            # lesquels l'introduisaient demande de les lire, et une troncature
            # dans un commentaire fait avaler la règle suivante.
            out.append(comments)
        elif len(kept) != len(selectors):
            out.append(comments + ",".join(kept) + "{" + body + "}")
        else:
            out.append(prelude + "{" + body + "}")
        i = j

    return "".join(out), removed


def leading_whitespace(prelude: str) -> str:
    match = re.match(r"\s*", prelude)
    return match.group(0) if match else ""


def sane(css: str) -> bool:
    """Garde-fou : accolades équilibrées et commentaires refermés."""
    return (
        css.count("{") == css.count("}")
        and css.count("/*") == css.count("*/")
        and "{" not in re.sub(r"/\*.*?\*/", "", css, flags=re.S).split("}")[-1]
    )


def main() -> int:
    dead = dead_classes(sources())
    print(f"{len(dead)} classes mortes")
    total_rules, total_lines = 0, 0

    for sheet in sorted(STYLES.glob("*.css")):
        before = sheet.read_text(encoding="utf8")
        after, removed = strip(before, dead)
        after = re.sub(r"\n{3,}", "\n\n", after).strip() + "\n"
        if after != before:
            if not sane(after):
                print(f"  {sheet.name}: RÉSULTAT INCOHÉRENT, fichier laissé intact")
                return 1
            lines = before.count("\n") - after.count("\n")
            total_rules += removed
            total_lines += lines
            print(f"  {sheet.name}: -{removed} règles, -{lines} lignes")
            if "--check" not in sys.argv:
                sheet.write_text(after, encoding="utf8")

    print(f"total : -{total_rules} règles, -{total_lines} lignes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
