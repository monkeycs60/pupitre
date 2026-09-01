import { expect, test } from 'bun:test'
import { parseSidequestDirective } from './sidequestDirective'

test('parse une sidequest héritée ou avec modèle explicite', () => {
  expect(parseSidequestDirective('@sidequest Analyse le bug')).toEqual({ instruction: 'Analyse le bug' })
  expect(parseSidequestDirective('@sidequest(model="5.6-luna") Analyse le bug')).toEqual({
    model: '5.6-luna', instruction: 'Analyse le bug',
  })
  expect(parseSidequestDirective('message normal')).toBeNull()
  expect(() => parseSidequestDirective('@sidequest(model=oops) test')).toThrow('Syntaxe')
})
