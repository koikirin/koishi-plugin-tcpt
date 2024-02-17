import { } from '@hieuzest/koishi-plugin-mahjong'
import { Context, Schema, Session } from 'koishi'
import { fillDocumentRounds, getEloClass } from './utils'
import { TziakchaLobby } from './lobby'

declare module 'koishi' {
  interface User {
    'tcpt/bind': string
  }
}

export class Tcpt {
  constructor(private ctx: Context, private config: Tcpt.Config) {
    ctx.i18n.define('zh-CN', require('./locales/zh-CN'))

    ctx.model.extend('user', {
      'tcpt/bind': 'string',
    })

    ctx.command('tcpt <username:rawtext>')
      .option('all', '-a')
      .option('common', '-c')
      .option('bind', '-b')
      .userFields(['tcpt/bind'])
      .action(async ({ session, options }, username) => {
        if (options.bind) session.user['tcpt/bind'] = username ?? ''
        username ||= session.user['tcpt/bind']
        if (!username) return options.bind ? '' : session.execute('tcpt -h')
        let filters: object = {
          'g.n': 16,
          'g.l': 8,
          'g.b': 8,
          'rd.15': { $exists: true },
        }
        let extra = session.text('.extra-default')
        if (options.all) {
          filters = {}
          extra = session.text('.extra-all')
        } else if (options.common) {
          filters = {
            'g.l': 8,
            'g.b': 8,
          }
          extra = session.text('.extra-common')
        }
        const res = await this.query(session, username.startsWith('$') ? +username.slice(1) : undefined, username, filters)
        return res ? res + (extra ? '\n' + extra : '') : session.text('.failed')
      })

    ctx.command('tcpt/tcnames <username:rawtext>')
      .action(async ({ session }, username) => {
        if (!username) return session.execute('tcnames -h')
        const names = await this.queryNames(ctx, null, username)
        if (names && Object.values(names).length) return Object.entries(names).sort(([_1, x], [_2, y]) => y - x).map(([k, v], _) => `[${v}] ${k}`).join('\n')
        return session.text('.failed')
      })

    ctx.plugin(TziakchaLobby, config)
  }

  async query(session: Session, id?: number, name?: string, filters: object = {}) {
    if (!id && !name) return
    else if (!id) {
      const cursor = this.ctx.mahjong.database.db('tziakcha').collection('matches').find({ 'u.n': name }).sort('st', 'descending').limit(1)
      const doc = await cursor.next()
      if (doc) {
        for (const u of doc.u) if (u.n === name) id = u.i
      } else return
    }
    name = undefined

    const cursor = this.ctx.mahjong.database.db('tziakcha').collection('matches').find({ 'u.i': id, ...filters }).sort('st', 'descending')

    const elo: [number?, number?, number?] = [undefined, undefined, undefined]
    const stats = {
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
      trend: '',
    }

    for await (let doc of cursor) {
      doc = fillDocumentRounds(doc)
      const eloClass = getEloClass(doc)
      stats.cnt += 1
      stats.cntr += doc.rounds.length
      let idx = -1
      doc.u.forEach((u, _idx) => {
        if (u.i === id) {
          idx = _idx
          if (!name) name = u.n
          if (!elo[eloClass] && typeof u.e === 'number') {
            elo[eloClass] = this.config.eloOrigin + u.l + u.e
          }
          const r = u.r + 1
          stats[`r${r}`] += 1
          stats[`r${r}s`] += u.s
          stats.trend += `${r}`
        }
      })

      for (const rnd of doc.rounds) {
        const { rs, rp } = rnd
        if (rs[idx] > 0) {
          stats.hule += 1
          if (rs[(idx + 1) % 4] === rs[(idx + 2) % 4] && rs[(idx + 1) % 4] === rs[(idx + 3) % 4]) stats.tsumo += 1
        } else if (rs[0] === 0 && rs[1] === 0 && rs[2] === 0 && rs[3] === 0) {
          ;
        } else if (rs[idx] < Math.max(...rs) && rs[idx] > Math.min(...rs)) {
          ;
        } else if (rs[(idx + 1) % 4] > rs[idx % 4] && rs[(idx + 2) % 4] > rs[idx % 4] && rs[(idx + 3) % 4] > rs[idx % 4]) {
          stats.chong += 1
        } else {
          stats.btsumo += 1
        }
        if (rp[idx] < 0) stats.cuohu += 1
        stats.rps += rp[idx]
      }
    }

    if (stats.hule === 0) { return session.text('.zero-hule') }

    function p(num: number, style = 'percent'): string {
      return new Intl.NumberFormat('default', {
        style,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(num)
    }

    const scores = stats.r1s + stats.r2s + stats.r3s + stats.r4s - stats.rps
    return session.text('.output', { p, config: this.config, elo, name, scores, stats })
  }

  async queryNames(ctx: Context, id?: number, name?: string) {
    if (!id && !name) return
    else if (!id) {
      const cursor = ctx.mahjong.database.db('tziakcha').collection('matches').find({ 'u.n': name }).sort('st', 'descending').limit(1)
      const doc = await cursor.next()
      if (doc) {
        for (const u of doc.u) if (u.n === name) id = u.i
      } else return
    }

    const cursor = ctx.mahjong.database.db('tziakcha').collection('matches').aggregate([
      { '$match': { 'u.i': id } },
      {
        '$project': {
          'list': {
            '$filter': {
              'input': '$u',
              'as': 'item',
              'cond': {
                '$eq': ['$$item.i', id],
              },
            },
          },
        },
      },
      { '$unwind': '$list' },
      {
        '$group': {
          '_id': '$list.n',
          'count': {
            '$count': {},
          },
        },
      },
    ])

    const names: { [key: string]: number } = {}
    for await (const doc of cursor) {
      names[doc._id] = doc.count
    }
    return names
  }
}

export namespace Tcpt {
  export const inject = ['database', 'mahjong', 'mahjong.database']

  export interface Config {
    eloOrigin: number
    lobby: TziakchaLobby.Config
   }

  export const Config: Schema<Config> = Schema.object({
    eloOrigin: Schema.number().default(2000),
    lobby: TziakchaLobby.Config,
  })
}

export default Tcpt
