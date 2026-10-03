import { useState } from 'react'

type MuseumFilter = 'all' | '1' | '2' | '3' | '4' | '5'

interface MuseumPiece {
  id: string
  level: MuseumFilter
  label: string
  title: string
  warning: string
  examples: string[]
  code: string
}

interface MuseumSample {
  name: string
  score: number
  id: number
}

const MUSEUM_PIECES: MuseumPiece[] = [
  {
    id: 'inline-style',
    level: '1',
    label: 'Petit délit',
    title: 'Le style inline qui se croit design system',
    warning: 'Tout est violet, rien n’est réutilisable, et la cascade CSS a démissionné.',
    examples: ['Styles inline répétés', 'Valeurs magiques', 'Texte sans constante'],
    code: "<button style={{ background: '#8b7cff', padding: 13 }}>Go</button>",
  },
  {
    id: 'index-key',
    level: '2',
    label: 'Mauvais présage',
    title: 'La clé React qui change de personnalité',
    warning: 'Un index suffit… jusqu’au jour où la liste est triée, filtrée ou supprimée.',
    examples: ['key={index}', 'Composant monolithique', 'Duplication JSX'],
    code: '{rows.map((row, index) => <Row key={index} {...row} />)}',
  },
  {
    id: 'mutable-state',
    level: '3',
    label: 'Zone rouge',
    title: 'La mutation d’état à mains nues',
    warning: 'Le tableau est modifié avant d’être recopié, comme si React n’avait rien vu.',
    examples: ['any[]', 'Mutation avant setState', 'Compteur avec fermeture obsolète'],
    code: 'items.push(newItem); setItems([...items]); setCount(count + 1)',
  },
  {
    id: 'dom-escape',
    level: '4',
    label: 'Crime organisé',
    title: 'Le DOM direct, parce que JSX est trop poli',
    warning: 'Une requête document.querySelector vient repeindre un nœud derrière le dos de React.',
    examples: ['querySelector', 'innerHTML', 'Effet de bord au clic'],
    code: "document.querySelector('.output').innerHTML = userInput",
  },
  {
    id: 'boss',
    level: '5',
    label: 'Boss final',
    title: 'Le composant qui veut devenir toute l’application',
    warning: 'État, logique métier, rendu, persistance et alerte navigateur vivent dans la même fonction.',
    examples: ['État dérivé stocké', 'localStorage au rendu', 'Alert() comme système de feedback'],
    code: 'function App() { /* 400 lignes, 17 états, bon courage */ }',
  },
]

const STARTER_SAMPLES: MuseumSample[] = [
  { name: 'Kevin from frontend', score: 7, id: 1 },
  { name: 'Le stagiaire invisible', score: 14, id: 2 },
  { name: 'Un ticket Jira', score: 22, id: 3 },
]

interface MuseumState {
  shame: number
  samples: MuseumSample[]
  globalShameLog: string[]
  lastIncident: string
}

function createInitialMuseumState(): MuseumState {
  return {
    shame: 12,
    samples: STARTER_SAMPLES.map((sample) => ({ ...sample })),
    globalShameLog: [],
    lastIncident: 'Aucun incident déclaré.',
  }
}

export function BadPracticesMuseum() {
  const [activeFilter, setActiveFilter] = useState<MuseumFilter>('all')
  const [selectedPiece, setSelectedPiece] = useState(0)
  const [visitorName, setVisitorName] = useState('')
  const [museumState, setMuseumState] = useState<MuseumState>(createInitialMuseumState)
  const [isEverythingOpen, setIsEverythingOpen] = useState(false)
  const { shame, samples, globalShameLog, lastIncident } = museumState

  const visiblePieces = activeFilter === 'all'
    ? MUSEUM_PIECES
    : MUSEUM_PIECES.filter((piece) => piece.level === activeFilter)
  const currentPiece = visiblePieces[selectedPiece] ?? visiblePieces[0] ?? MUSEUM_PIECES[0]
  const shamePercent = Math.min(100, shame * 3)
  const visitorLabel = visitorName || 'visiteur anonyme'

  function registerIncident() {
    setMuseumState((current) => {
      const nextShame = current.shame + 1
      const nextGlobalShameLog = [...current.globalShameLog, visitorLabel]

      return {
        shame: nextShame,
        samples: [
          ...current.samples,
          { name: visitorLabel, score: nextShame, id: Math.random() },
        ],
        globalShameLog: nextGlobalShameLog,
        lastIncident: `Incident #${nextGlobalShameLog.length} enregistré pour ${visitorLabel}.`,
      }
    })
  }

  function filterPieces(filter: MuseumFilter) {
    setActiveFilter(filter)
    setSelectedPiece(0)
  }

  function repaintBehindReact() {
    setMuseumState((current) => ({
      ...current,
      lastIncident: `Le DOM a parlé à ${new Date().toLocaleTimeString('fr-FR')}.`,
    }))
  }

  function clearEvidence() {
    setMuseumState((current) => ({
      ...current,
      samples: [],
      shame: 0,
      globalShameLog: [],
      lastIncident: 'Les preuves ont été supprimées sans confirmation.',
    }))
  }

  return (
    <section className="bad-practices-view" aria-labelledby="bad-practices-title">
      <header className="bad-practices-header">
        <div>
          <h1 id="bad-practices-title">Musée des mauvaises pratiques</h1>
          <p>Une exposition interactive de décisions qu’on ne devrait jamais copier en production.</p>
        </div>
        <div className="bad-practices-header-score" aria-label={`${shame} points de honte`}>
          <span>Honte cumulée</span>
          <strong>{shame}</strong>
        </div>
      </header>

      <div className="bad-practices-layout">
        <aside className="bad-practices-index" aria-label="Niveaux de mauvaises pratiques">
          <p className="bad-practices-index-title">Choisir un niveau</p>
          <button type="button" className={activeFilter === 'all' ? 'is-active' : ''} onClick={() => filterPieces('all')}>
            Toutes les catastrophes <span>{MUSEUM_PIECES.length}</span>
          </button>
          {MUSEUM_PIECES.map((piece) => (
            <button
              type="button"
              key={piece.id}
              className={activeFilter === piece.level ? 'is-active' : ''}
              onClick={() => filterPieces(piece.level)}
            >
              <span>Niveau {piece.level}</span>
              <small>{piece.label}</small>
            </button>
          ))}
          <div className="bad-practices-index-note">
            <strong>Règle du musée</strong>
            <p>Plus c’est facile à écrire, plus ça mérite probablement une review.</p>
          </div>
        </aside>

        <div className="bad-practices-main">
          <div className="bad-practices-specimen-list">
            {visiblePieces.map((piece, index) => (
              <button
                type="button"
                key={piece.id}
                className={`bad-practices-specimen ${currentPiece.id === piece.id ? 'is-selected' : ''}`}
                onClick={() => setSelectedPiece(index)}
              >
                <span className="bad-practices-specimen-level">0{piece.level}</span>
                <span>
                  <strong>{piece.title}</strong>
                  <small>{piece.label}</small>
                </span>
              </button>
            ))}
          </div>

          <article className="bad-practices-detail">
            <div className="bad-practices-detail-heading">
              <div>
                <p className="bad-practices-level">Niveau {currentPiece.level} · {currentPiece.label}</p>
                <h2>{currentPiece.title}</h2>
                <p>{currentPiece.warning}</p>
              </div>
              <span className="bad-practices-stamp">NE PAS COPIER</span>
            </div>

            <div className="bad-practices-detail-grid">
              <div>
                <h3>Ce que vous avez gagné</h3>
                <ul>
                  {currentPiece.examples.map((example, index) => <li key={index}>{example}</li>)}
                </ul>
              </div>
              <pre><code>{currentPiece.code}</code></pre>
            </div>

            <div className="bad-practices-demo">
              <div className="bad-practices-demo-heading">
                <div>
                  <h3>Laboratoire du chaos</h3>
                  <p>Entrez un nom, puis observez une décision discutable se propager.</p>
                </div>
                <button type="button" onClick={() => setIsEverythingOpen(!isEverythingOpen)}>
                  {isEverythingOpen ? 'Refermer les dégâts' : 'Tout ouvrir'}
                </button>
              </div>

              <div className="bad-practices-form">
                <label htmlFor="bad-practices-name">Nom du prochain responsable</label>
                <input
                  id="bad-practices-name"
                  value={visitorName}
                  onChange={(event) => setVisitorName(event.target.value)}
                  placeholder="ex. la personne qui a dit 'ça ira vite'"
                />
                <button type="button" onClick={registerIncident}>Ajouter une dette</button>
              </div>

              <div className="bad-practices-output" aria-live="polite">{lastIncident}</div>

              {isEverythingOpen ? (
                <div className="bad-practices-extra">
                  <button type="button" onClick={repaintBehindReact}>Peindre derrière React</button>
                  <button type="button" onClick={clearEvidence}>Effacer les preuves</button>
                  <p>Échantillons suspects : {samples.length} · journal global : {globalShameLog.length}</p>
                </div>
              ) : null}
            </div>
          </article>

          <div className="bad-practices-meter" aria-label={`Niveau de honte ${shamePercent}%`}>
            <div className="bad-practices-meter-label"><span>Barre de honte</span><strong>{shamePercent}%</strong></div>
            <div className="bad-practices-meter-track"><span style={{ width: `${shamePercent}%` }} /></div>
          </div>
        </div>
      </div>
    </section>
  )
}
