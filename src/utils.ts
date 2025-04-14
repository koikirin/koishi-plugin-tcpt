// function calcRK(mp) {
//   const rks = [0, 0, 0, 0]
//   let i, j
//   for (i = 0; i < 4; ++i) {
//     for (j = 0; j < 4; ++j) {
//       if (i == j) continue
//       if (mp[i] < mp[j])++rks[i]
//     }
//   }
//   return rks
// }

function calcRS(v, b) {
  const a = [0, 0, 0, 0], f = v >> 16
  let w, c, i, s, t
  if (f) {
    for (i = 0; i < 4; ++i) {
      if (v & (1 << i))w = i
      if (v & (1 << (i + 4)))c = i
    }
    if (w !== c) {
      s = -b
      for (i = 0; i < 4; ++i) {
        if (i === w)a[i] = f + b * 3
        else if (i === c)a[i] = s - f
        else a[i] = s
      }
    } else {
      s = b + f
      t = s * 3
      s = -s
      for (i = 0; i < 4; ++i) {
        a[i] = i !== w ? s : t
      }
    }
  }
  return a
}

function calcRP(v, f) {
  const a = [0, 0, 0, 0]
  let i, c = 0, t
  for (i = 0; i < 4; ++i) {
    if (v & (1 << (i + 8))) {
      a[i] -= 40
      ++c
    }
  }
  if (c && f) {
    t = c * 10
    for (i = 0; i < 4; ++i) {
      a[i] += t
    }
  }
  return a
}

export function fmtTl(p, s, e, l) {
  let r = '' + p
  if (p !== s) { r += '/'; r += s }
  if (e || p === s) { r += '+'; r += e }
  if (l) { r += ' ('; r += (l * 5); r += ')' }
  return r
}

function _getEloClass(doc: any) {
  const [p, e] = [doc.g.r30 ?? doc.g.r0, doc.g.e]
  if (p <= 3) {
    if (e <= 5) return 0
    else if (e <= 10) return 1
    else if (e <= 15) return 2
    else return 3
  } else if (p <= 5) {
    if (e <= 0) return 1
    else if (e <= 10) return 2
    else if (e <= 15) return 3
    else return 4
  } else if (p <= 8) {
    if (e <= 5) return 3
    else return 4
  } else if (p <= 10) {
    if (e <= 0) return 3
    else return 4
  } else return 4
}

export function getEloClass(doc: any) {
  const c = _getEloClass(doc)
  return c <= 1 ? 0 : c <= 3 ? 1 : 2
}

export const EloLabels = ['快速', '常规', '经典']

export function fillDocumentRounds(doc: any, normalized = false): any {
  const rounds = []
  const bs = (normalized || doc.g.b === undefined) ? 8 : doc.g.b
  const fa = doc.g.fa
  for (const rd of doc.rd) {
    rounds.push({
      rs: calcRS(rd.rbf, bs),
      rp: calcRP(rd.rbf, fa),
    })
  }
  doc.rounds = rounds
  return doc
}

export function fillDocumentRounds2(doc: any, normalized = false): any {
  const bs = (normalized || doc.g.b === undefined) ? 8 : doc.g.b
  const z = doc.g.z
  for (const rd of doc.records) {
    rd.rs = calcRS(rd.s, bs)
    rd.rp = calcRP(rd.s, z)
  }
  return doc
}

export function solveWaitingTiles(hand: string) {
  const tiles = hand.split('').map(Number)
  const tileCounts = new Array(10).fill(0)
  for (const tile of tiles) {
    tileCounts[tile]++
  }
  const result = []

  function isComplete(tileCounts: number[], state: number = 0) {
    if (state === 4) {
      for (let i = 1; i <= 9; i++) {
        if (tileCounts[i] === 2) {
          return true
        }
      }
    }

    // try sequence
    for (let i = 1; i <= 7; i++) {
      if (tileCounts[i] > 0 && tileCounts[i + 1] > 0 && tileCounts[i + 2] > 0) {
        tileCounts[i]--
        tileCounts[i + 1]--
        tileCounts[i + 2]--
        if (isComplete(tileCounts, state + 1)) return true
        tileCounts[i]++
        tileCounts[i + 1]++
        tileCounts[i + 2]++
      }
    }

    // try triplet
    for (let i = 1; i <= 9; i++) {
      if (tileCounts[i] >= 3) {
        tileCounts[i] -= 3
        if (isComplete(tileCounts, state + 1)) return true
        tileCounts[i] += 3
      }
    }
  }

  for (let i = 1; i <= 9; i++) {
    if (tileCounts[i] < 4) {
      tileCounts[i]++
      if (isComplete(tileCounts.slice())) result.push(i)
      tileCounts[i]--
    }
  }

  return result.join('')
}
