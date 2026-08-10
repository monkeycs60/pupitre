# Sélecteur unifié de modèle et presets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remplacer les formulaires de configuration par un sélecteur compact de presets et de modèles, utilisable pour une nouvelle conversation et le changement de modèle d'une conversation existante.

**Architecture:** Centraliser le catalogue de modèles et les calculs de coût dans `modelOptions.ts`, puis rendre un composant `ModelConfigSelector` contrôlé. Un hook charge et manipule les presets pour les deux points d'entrée ; `ConfigPanel` conserve l'initialisation du preset par défaut et `SwitchModelModal` conserve les appels de bascule et de handoff.

**Tech Stack:** React 19, TypeScript, CSS classique, Bun test, Testing Library, API sidecar existante.

## Global Constraints

- Référence visuelle : `Refonte UIUX app Tori (3).zip` ; la version 3 prévaut sur les versions 1 et 2.
- Les presets sont illimités : la liste du menu doit défiler et ne jamais tronquer à trois éléments.
- Les tarifs API sont des repères relatifs, pas une facture d'abonnement ; le menu doit le dire explicitement.
- Le changement de provider dans une conversation existante doit continuer à passer par le handoff et son estimation de contexte.
- Ne pas modifier le schéma SQLite, le `PresetStore` ni les routes API de presets.
- Respecter `prefers-reduced-motion`, le focus visible et la navigation clavier de base.
- Ne pas ajouter de dépendance frontend.

---

## Structure des fichiers

| Fichier | Responsabilité |
|---|---|
| `ui/src/modelOptions.ts` | Catalogue typé, coûts relatifs, jauges, tons et format de prix. |
| `ui/src/modelOptions.test.ts` | Tests purs du catalogue et de ses calculs. |
| `ui/src/ModelConfigSelector.tsx` | Chip, menu en cascade et sous-menus de réglage contrôlés. |
| `ui/src/ModelConfigSelector.test.tsx` | Interactions : presets illimités, sélection, état modifié et modèle inter-provider. |
| `ui/src/ConfigPanel.tsx` | Adaptateur de création : preset par défaut + sélecteur partagé. |
| `ui/src/SwitchModelModal.tsx` | Adaptateur de bascule : sélecteur partagé + confirmation switch/handoff. |
| `ui/src/SwitchModelModal.test.tsx` | Régression de la confirmation switch et handoff après sélection. |
| `ui/src/Composer.tsx` | Place le chip dans la barre d'action et supprime le résumé technique redondant. |
| `ui/src/styles/composer.css` | Mise en page légère du composer et styles du sélecteur à cet emplacement. |
| `ui/src/styles/dialogs.css` | Largeur et défilement de la modale de bascule équipée du sélecteur. |

## Task 1: Catalogue tarifaire et calculs purs

**Files:**
- Create: `ui/src/modelOptions.test.ts`
- Modify: `ui/src/modelOptions.ts`

**Interfaces:**
- Consumes: `Provider` depuis `ui/src/types.ts` et `PROVIDER_MODELS` existant.
- Produces: `MODEL_PRICING`, `modelPricing`, `modelExchangeCost`, `modelCostTicks`, `modelCostTone`, `relativeCostLabel`, `formatModelPrice` et `MODEL_COST_TICKS`.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from 'bun:test'
import {
  formatModelPrice,
  modelCostTicks,
  modelCostTone,
  relativeCostLabel,
} from './modelOptions'

test('compare le coût absolu et relatif des modèles', () => {
  expect(modelCostTicks('gpt-5.6-luna')).toBe(1)
  expect(modelCostTicks('fable-5')).toBe(20)
  expect(modelCostTone('gpt-5.6-luna')).toBe('ok')
  expect(modelCostTone('opus')).toBe('danger')
  expect(relativeCostLabel('gpt-5.6-luna', 'gpt-5.6-sol')).toBe('÷25')
  expect(relativeCostLabel('gpt-5.6-sol', 'gpt-5.6-luna')).toBe('×25')
  expect(formatModelPrice('gpt-5.6-luna')).toBe('0,20 / 1,20 $')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ui/src/modelOptions.test.ts`
Expected: FAIL because the pricing exports do not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
export const MODEL_COST_TICKS = 20
export const MODEL_PRICING = [
  { provider: 'codex', model: 'gpt-5.6-sol', input: 5, output: 30 },
  { provider: 'codex', model: 'gpt-5.6-luna', input: 0.2, output: 1.2 },
  { provider: 'codex', model: 'gpt-5.6-terra', input: 2, output: 12 },
  { provider: 'claude', model: 'fable-5', input: 10, output: 50 },
  { provider: 'claude', model: 'opus', input: 5, output: 25 },
  { provider: 'claude', model: 'sonnet', input: 2, output: 10 },
  { provider: 'claude', model: 'haiku', input: 1, output: 5 },
] as const

export function relativeCostLabel(candidate: string, selected: string): string {
  const ratio = modelExchangeCost(candidate) / modelExchangeCost(selected)
  if (ratio >= 1.5) return `×${Math.round(ratio)}`
  if (ratio <= 0.67) return `÷${Math.round(1 / ratio)}`
  return '×1'
}
```

Le coût d'échange utilise strictement 40 000 tokens d'entrée et 3 000 tokens de sortie. Les crans sont linéaires par rapport au coût maximal et bornés entre 1 et 20. Le ton se calcule par rapport au coût minimal, jamais au modèle sélectionné.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test ui/src/modelOptions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/modelOptions.ts ui/src/modelOptions.test.ts
git commit -m "feat(ui): ajoute le catalogue tarifaire des modèles"
```

## Task 2: Sélecteur contrôlé et tests d'interaction

**Files:**
- Create: `ui/src/ModelConfigSelector.tsx`
- Create: `ui/src/ModelConfigSelector.test.tsx`
- Modify: `ui/src/styles/composer.css`

**Interfaces:**
- Consumes: `ConversationConfig` depuis `ConfigPanel.tsx`, `Preset`, `QuotaSnapshot`, les exports de `modelOptions.ts` et des callbacks contrôlés.
- Produces: `ModelConfigSelector`, avec `config`, `presets`, `selectedPresetId`, `quotas`, `onConfigChange`, `onPresetSelect`, `onSaveAs`, `onOverwrite`, `onRevert` et `onPresetAction`.

- [ ] **Step 1: Write the failing tests**

```tsx
test('affiche plus de 100 presets dans une liste défilante', () => {
  render(createElement(ModelConfigSelector, { ...props, presets: makePresets(101) }))
  fireEvent.click(screen.getByRole('button', { name: /réglages libres|preset/i }))
  expect(screen.getByText('Preset 101')).toBeTruthy()
  expect(screen.getByLabelText('Presets disponibles').className).toContain('preset-selector-list')
})

test('un modèle Claude modifie provider, modèle et valeurs dépendantes', () => {
  render(createElement(ModelConfigSelector, props))
  fireEvent.click(screen.getByRole('button', { name: /réglages libres|vitesse/i }))
  fireEvent.click(screen.getByRole('button', { name: 'Fable 5' }))
  expect(onConfigChange).toHaveBeenCalledWith(expect.objectContaining({
    provider: 'claude', model: 'fable-5', effort: 'high', speed: 'standard',
  }))
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test ui/src/ModelConfigSelector.test.tsx`
Expected: FAIL because `ModelConfigSelector` does not exist.

- [ ] **Step 3: Write the minimal component and styles**

```tsx
export function ModelConfigSelector({ config, presets, selectedPresetId, quotas, onConfigChange, onPresetSelect }: Props) {
  const [open, setOpen] = useState(false)
  const [submenu, setSubmenu] = useState<Submenu | null>(null)
  return <div className="preset-selector">{/* chip, popover et sous-menus */}</div>
}
```

Rendre un chip de 28 px, un menu principal de 286 px et un sous-menu modèle de 610 px. La liste de presets porte `aria-label="Presets disponibles"`, `max-height` et `overflow-y: auto`. Un clic sur un modèle d'un autre provider met à jour provider, premier modèle compatible seulement si la sélection n'est pas explicitement choisie, effort `high` et vitesse `standard`. Le sous-menu affiche les deux providers, même en l'absence de quota, avec une mention « quota indisponible ».

- [ ] **Step 4: Add keyboard and modified-state coverage**

```tsx
test('signale une configuration modifiée et permet le retour au preset', () => {
  render(createElement(ModelConfigSelector, { ...props, selectedPresetId: 'speed' }))
  fireEvent.click(screen.getByRole('button', { name: /vitesse/i }))
  fireEvent.click(screen.getByRole('button', { name: '5.6 Sol' }))
  expect(screen.getByText('Réglages différents de Vitesse')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Revenir à Vitesse' }))
  expect(onRevert).toHaveBeenCalled()
})
```

Gérer Échap, clic hors du popover et `prefers-reduced-motion`. Les boutons de sous-menu gardent le menu principal ouvert après une sélection.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test ui/src/ModelConfigSelector.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ui/src/ModelConfigSelector.tsx ui/src/ModelConfigSelector.test.tsx ui/src/styles/composer.css
git commit -m "feat(ui): ajoute le sélecteur compact de modèles"
```

## Task 3: État et opérations de presets conservés dans ConfigPanel

**Files:**
- Modify: `ui/src/ConfigPanel.tsx`
- Modify: `ui/src/ModelConfigSelector.tsx`

**Interfaces:**
- Consumes: `listPresets`, `createPreset`, `updatePreset`, `deletePreset`, `restorePreset`, `setProjectDefaultPreset`, `Project`, `Preset` et `ConversationConfig`.
- Produces: `ConfigPanel`, qui fournit au sélecteur `presets`, `selectedPresetId`, `selectPreset`, `saveAs`, `overwrite`, `rename`, `remove`, `restore`, `toggleProjectDefault` et `revert`.

- [ ] **Step 1: Write the failing hook/controller test through ConfigPanel**

```tsx
test('charge le preset par défaut, puis conserve une liste complète après création', async () => {
  installApi({ presets: makePresets(101), projectDefaultId: 'preset-50' })
  render(createElement(ConfigPanel, props))
  expect(await screen.findByText('Preset 50')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /preset 50/i }))
  fireEvent.click(screen.getByRole('button', { name: /enregistrer comme preset/i }))
  // la réponse POST devient sélectionnée sans perdre les 101 entrées chargées
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ui/src/ModelConfigSelector.test.tsx`
Expected: FAIL because ConfigPanel ne fournit pas encore le sélecteur et le contrôleur partagés.

- [ ] **Step 3: Extract controller and reduce ConfigPanel**

```tsx
export function ConfigPanel(props: ConfigPanelProps) {
  return <ModelConfigSelector
    config={props.config}
    presets={presets}
    selectedPresetId={selectedPresetId}
    quotas={props.quotas}
    onConfigChange={props.onConfigChange}
    onPresetSelect={handlePresetChange}
    onRevert={() => selectedPreset && props.onConfigChange(configOf(selectedPreset))}
  />
}
```

Conserver `configOf` et `sameConfig` en exports testables ou les déplacer dans le hook. Sur suppression, vider la sélection sans modifier la configuration en cours. Sur restauration ou retour, réappliquer exactement la configuration du preset. Sur défaut de projet, utiliser l'API existante et propager le projet retourné.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test ui/src/ModelConfigSelector.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/ConfigPanel.tsx ui/src/ModelConfigSelector.tsx ui/src/ModelConfigSelector.test.tsx
git commit -m "refactor(ui): partage la gestion des presets"
```

## Task 4: Composer allégé et modale de changement unifiée

**Files:**
- Modify: `ui/src/Composer.tsx`
- Modify: `ui/src/SwitchModelModal.tsx`
- Create: `ui/src/SwitchModelModal.test.tsx`
- Modify: `ui/src/App.tsx`
- Modify: `ui/src/styles/composer.css`
- Modify: `ui/src/styles/dialogs.css`

**Interfaces:**
- Consumes: `ModelConfigSelector`, `ConfigPanel`, `Project`, `Conversation`, `switchConversationModel`, `handoffConversation` et `estimatedReingestionTokens`.
- Produces: un chip dans la barre d'actions d'une nouvelle discussion et une modale de changement qui emploie le même sélecteur avant sa confirmation.

- [ ] **Step 1: Write the failing modale test**

```tsx
test('transmet un changement inter-provider au handoff après confirmation', async () => {
  render(createElement(SwitchModelModal, { conversation, events: [], project, ...callbacks }))
  fireEvent.click(screen.getByRole('button', { name: /gpt-5.6 sol/i }))
  fireEvent.click(screen.getByRole('button', { name: /créer la suite/i }))
  await waitFor(() => expect(fetch).toHaveBeenCalledWith(
    `/api/conversations/${conversation.id}/handoff`, expect.anything(),
  ))
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ui/src/SwitchModelModal.test.tsx`
Expected: FAIL because the modal test and the shared selector wiring do not yet exist.

- [ ] **Step 3: Wire the new-conversation composer**

```tsx
<div className="composer-actions">
  <div className="composer-tools">{/* pièces jointes et actions */}</div>
  {isNewConversation ? <ConfigPanel {...configProps} /> : null}
  <div className="composer-send">{/* annuler ou envoyer */}</div>
</div>
```

Supprimer `composerModel` pour la nouvelle conversation et ne plus rendre `ConfigPanel` avant les pièces jointes. Le textarea reste la première zone du formulaire. Le chip reste proche du bouton d'envoi sans écraser les outils d'attachement.

- [ ] **Step 4: Wire SwitchModelModal and preserve handoff**

```tsx
const isHandoff = config.provider !== conversation.provider
const input = {
  provider: config.provider,
  model: config.model,
  effort: config.effort,
  speed: config.provider === 'codex' ? config.speed : null,
  orchestrator: conversation.orchestrator,
}
```

Passer `selectedProject` à `SwitchModelModal` depuis `App.tsx`. Réutiliser `ConfigPanel` avec `applyProjectDefault={false}` afin de charger les presets sans écraser la configuration de la conversation ; le composant conserve ainsi les mêmes opérations sur presets que la création. Conserver intégralement l'avertissement de handoff, l'estimation de tokens, les états de soumission, les erreurs et le libellé du bouton.

- [ ] **Step 5: Run targeted tests to verify they pass**

Run: `bun test ui/src/ModelConfigSelector.test.tsx ui/src/SwitchModelModal.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ui/src/App.tsx ui/src/Composer.tsx ui/src/SwitchModelModal.tsx ui/src/SwitchModelModal.test.tsx ui/src/styles/composer.css ui/src/styles/dialogs.css
git commit -m "feat(ui): unifie le changement de modèle"
```

## Task 5: Régression, build et contrôle visuel

**Files:**
- Modify: fichiers de test touchés seulement si une attente doit refléter l'interface validée.

**Interfaces:**
- Consumes: tous les composants et tests des tâches 1 à 4.
- Produces: build TypeScript/Vite propre et couverture des flux concernés.

- [ ] **Step 1: Run focused UI and sidecar tests**

Run: `bun test ui/src/modelOptions.test.ts ui/src/ModelConfigSelector.test.tsx ui/src/SwitchModelModal.test.tsx sidecar/tests/presets.test.ts sidecar/tests/ui-model-switch.test.ts`
Expected: PASS.

- [ ] **Step 2: Run static checks and production build**

Run: `bun run --cwd ui lint && bun run --cwd ui build`
Expected: exit code 0.

- [ ] **Step 3: Perform manual checks**

Run: `bun run --cwd ui dev -- --host 127.0.0.1`
Expected: vérifier une nouvelle discussion avec 101 presets, les trois états du chip, le modèle Claude puis Codex, le quota absent, Échap et `prefers-reduced-motion`; ouvrir ensuite une conversation et vérifier un switch local puis un handoff.

- [ ] **Step 4: Commit final verification fixes**

```bash
git add ui/src
git commit -m "test(ui): vérifie le sélecteur de configuration"
```
