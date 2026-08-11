import { expect, test } from 'bun:test'
import { needsDesignLogin } from './designSession'

test('signale la page marketing comme une session absente', () => {
  expect(needsDesignLogin('https://claude.com/product/design')).toBe(true)
})

test("ne signale rien quand l'outil est bien chargé", () => {
  expect(needsDesignLogin('https://claude.ai/design/')).toBe(false)
  expect(needsDesignLogin('https://claude.ai/design/019e2187-fb46-71f4-8546-559244c11de1')).toBe(false)
})

test('laisse passer les étapes légitimes du flux de connexion', () => {
  // Avertir ici afficherait une alerte en pleine connexion, alors que tout va bien.
  expect(needsDesignLogin('https://claude.ai/login')).toBe(false)
  expect(needsDesignLogin('https://accounts.google.com/v3/signin/identifier?foo=bar')).toBe(false)
  expect(needsDesignLogin('https://claude.ai/api/challenge_redirect?to=x')).toBe(false)
})

test('reste silencieux sans URL ou sur une URL illisible', () => {
  expect(needsDesignLogin(null)).toBe(false)
  expect(needsDesignLogin(undefined)).toBe(false)
  expect(needsDesignLogin('')).toBe(false)
  expect(needsDesignLogin('pas une url')).toBe(false)
})
