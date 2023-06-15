import { } from '@hieuzest/koishi-plugin-mahjong'
import { Context, Schema } from 'koishi'
import { fillDocumentRounds } from './utils'
export const name = 'tcpt'
export const using = ['mahjong']

export interface Config {}

export const Config: Schema<Config> = Schema.object({})

async function query(ctx: Context, id?: number, name?: string, filters: object = {}) {
  if (!id && !name) return
  else if (!id) {
    const cursor = ctx.mahjong.db.db('tziakcha').collection('matches').find({'u.n': name}).sort('st', 'descending').limit(1)
    const doc = await cursor.next()
    if (doc) {
      for (const u of doc.u) if (u.n == name) id = u.i
    } else return
  }

  const cursor = ctx.mahjong.db.db('tziakcha').collection('matches').find({'u.i': id, ...filters}).sort('st', 'descending')

  let stats = {
    cnt: 0,
    cntr: 0,
    r1: 0,
    r1s: 0,
    r2: 0,
    r2s: 0,
    r3: 0,
    r3s: 0,
    r4: 0,
    r4s: 0,
    rps: 0,
    hule: 0,
    tsumo: 0,
    chong: 0,
    btsumo: 0,
    cuohu: 0,
    trend: ''
  }

  for await (let doc of cursor) {
    doc = fillDocumentRounds(doc)
    stats.cnt += 1
    stats.cntr += doc.rounds.length
    let idx = -1
    doc.u.forEach((u, _idx) => {
      if (u.i === id) {
        idx = _idx
        if (!name) name = u.n
        const r = u.r + 1
        stats[`r${r}`] += 1
        stats[`r${r}s`] += u.s
        stats.trend += `${r}`
      }
    });

    for (const rnd of doc.rounds) {
      let { rs, rp } = rnd
      if (rs[idx] > 0) {
        stats.hule += 1
        if (rs[(idx + 1) % 4] === rs[(idx + 2) % 4] && rs[(idx + 1) % 4] === rs[(idx + 3) % 4]) stats.tsumo += 1
      } else if (rs[0] == 0 && rs[1] == 0 && rs[2] == 0 && rs[3] == 0) {

      } else if (rs[idx] < Math.max(...rs) && rs[idx] > Math.min(...rs)) {

      } else if (rs[(idx + 1) % 4] > rs[idx % 4] && rs[(idx + 2) % 4] > rs[idx % 4] && rs[(idx + 3) % 4] > rs[idx % 4]) {
        stats.chong += 1
      } else {
        stats.btsumo += 1
      }
      if (rp[idx] < 0) stats.cuohu += 1
      stats.rps += rp[idx]
    }
  }

  if (stats.hule == 0)
    return '错误：账号胡率为0'
  
  function p(num: number, style = 'percent'): string {
    return new Intl.NumberFormat('default', {
      style: style,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(num);
  }

  const scores = stats.r1s + stats.r2s + stats.r3s + stats.r4s - stats.rps
  let msg = `${name} 合计${stats.cnt}战 [${stats.r1}/${stats.r2}/${stats.r3}/${stats.r4}]
和率${p(stats.hule/stats.cntr)} 铳率${p(stats.chong/stats.cntr)} 平分${p(scores/stats.cntr, 'decimal')}
自摸率${p(stats.tsumo/stats.hule)} 被摸率${p(stats.btsumo/stats.cntr)} 错和分${p(stats.cuohu/stats.cntr)}
最近战绩 [${stats.trend.slice(-10).split('').reverse().join('')}]`
  return msg
}


export function apply(ctx: Context) {
  ctx.command('tcpt <username>')
    .option('all', '-a')
    .option('common', '-c')
    .action(async ({ session, options }, username) => {
      if (!username) return null
      let filters: object = {
        'g.n': 16,
        'g.l': 8,
        'g.b': 8,
        'rd.15': { $exists: true }
      }
      let extra = '\n*仅计入完场全庄'
      if (options.all) {
        filters = {}
        extra = ''
      } else if (options.common) {
        filters = {
          'g.l': 8,
          'g.b': 8
        }
        extra = '\n*仅计入8(8)'
      }
      query(ctx, null, username, filters).then(s => session.send(s ? s + extra : '查询失败'), e => session.send(`查询失败${e}`))
    })
}
