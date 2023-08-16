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
