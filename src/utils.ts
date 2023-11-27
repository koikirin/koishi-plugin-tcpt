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

// function fmt_tl(p, s, e, l) {
//   let r = '' + p
//   if (p !== s) { r += '/'; r += s }
//   if (e || p === s) { r += '+'; r += e }
//   if (l) { r += ' ('; r += (l * 5); r += ')' }
//   return r
// }

function _getEloClass(doc: any) {
  const [p, e] = [doc.g.r30, doc.g.e]
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

export function fillDocumentRounds(doc: any): any {
  const rounds = []
  const bs = doc.g.b === undefined ? 8 : doc.g.b
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
