import { Context, Dict, h, Schema, Session } from 'koishi'
import { CanvasTable } from '@hieuzest/canvas-table'
import { } from '@koishijs/canvas'
import { } from '@hieuzest/koishi-plugin-mahjong'
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

    ctx.command('tcpt [username:rawtext]')
      .option('all', '-a')
      .option('common', '-c')
      .option('bind', '-b')
      .userFields(['tcpt/bind'])
      .action(async ({ session, options }, username) => {
        if (options.bind) session.user['tcpt/bind'] = username ?? ''
        username ||= session.user['tcpt/bind']
        if (!username) return options.bind ? '' : session.execute('help tcpt')
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
        const res = await this.query(session, username.startsWith('$') ? +username.slice(1) : await this.queryId(username), filters)
        return res ? res + (extra ? '\n' + extra : '') : session.text('.failed')
      })

    ctx.command('tcpt/tcnames <username:rawtext>')
      .action(async ({ session }, username) => {
        if (!username) return session.execute('help tcnames')
        const names = await this.queryNames(await this.queryId(username))
        if (names && Object.values(names).length) return Object.entries(names).sort(([_1, x], [_2, y]) => y - x).map(([k, v], _) => `[${v}] ${k}`).join('\n')
        return session.text('.failed')
      })

    ctx.command('tcpt/tcagainst <pattern:rawtext>')
      .alias('tcag')
      .userFields(['tcpt/bind'])
      .action(async ({ session }, pattern) => {
        const usernames = pattern?.split(/\s+/)
        if (!usernames?.length || (!session.user['tcpt/bind'] && usernames.length < 2)) return session.execute('help tcagainst')
        const username = usernames.length === 2 ? usernames[0] : session.user['tcpt/bind']
        const target = usernames[usernames.length - 1]
        const id = await this.queryId(username), targetId = await this.queryId(target)
        const stats = await this.queryAgainsts(id, {}, { target: targetId })
        return await this.formatAgainst(stats, `${username} 的同桌统计`)
      })

    ctx.command('tcpt/tcagainsts [username:rawtext]')
      .alias('tcags')
      .option('count', '-n <number>', { fallback: 10 })
      .userFields(['tcpt/bind'])
      .action(async ({ session, options }, username) => {
        username ||= session.user['tcpt/bind']
        if (!username) return session.execute('help tcagainsts')
        const id = await this.queryId(username)
        let stats = await this.queryAgainsts(id, {}, { mincnt: options.count })
        if (stats.length > config.maxAgainstsTop + config.maxAgainstsBottom) {
          stats = [...stats.slice(0, config.maxAgainstsTop), ...stats.slice(-config.maxAgainstsBottom)]
        }
        return await this.formatAgainst(stats, `${username} 的同桌统计`)
      })

    ctx.plugin(TziakchaLobby, config)
  }

  async queryId(name: string) {
    const cursor = this.ctx.mahjong.database.db('tziakcha').collection('matches').find({ 'u.n': name }).sort('st', 'descending').limit(1)
    const doc = await cursor.next()
    if (doc) for (const u of doc.u) if (u.n === name) return u.i
  }

  async query(session: Session, id: number, filters: object = {}) {
    let name: string

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

    function p(num: number, style: 'percent' | 'decimal' = 'percent'): string {
      return style === 'percent' ? (num * 100).toFixed(2) + '%' : num.toFixed(2)
    }

    const scores = stats.r1s + stats.r2s + stats.r3s + stats.r4s - stats.rps
    return session.text('.output', { p, config: this.config, elo, name, scores, stats })
  }

  async queryNames(id: number) {
    const cursor = this.ctx.mahjong.database.db('tziakcha').collection('matches').aggregate([
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

  async queryAgainsts(id: number, filters: object = {}, options: {
    mincnt?: number
    target?: number
  } = {}): Promise<Tcpt.Against[]> {
    const cursor = this.ctx.mahjong.database.db('tziakcha').collection('matches')
      .find({ 'u.i': options.target ? { $all: [id, options.target] } : id, ...filters })
      .sort('st', 'descending')
    const rs: Dict<Tcpt.Against> = Object.create(null)

    for await (let doc of cursor) {
      doc = fillDocumentRounds(doc)
      let idx = -1
      doc.u.forEach((u, _idx) => {
        if (u.i === id) idx = _idx
      })
      doc.u.forEach((u, _idx) => {
        rs[u.i] ??= { id: u.i, name: u.n, rank: 0, cnt: 0, m1: 0, m2: 0, m3: 0, m4: 0, ms: 0, r1: 0, r2: 0, r3: 0, r4: 0, rs: 0, win: 0, value: 0 }
        rs[u.i].cnt += 1
        rs[u.i][`m${doc.u[idx].r + 1}`] += 1
        rs[u.i].ms += doc.u[idx].s
        rs[u.i][`r${u.r + 1}`] += 1
        rs[u.i].rs += u.s
        rs[u.i].win += u.r < doc.u[idx].r ? 1 : 0
        rs[u.i].value += u.r - doc.u[idx].r
      })
    }
    const list = Object.entries(rs)
      .map(([i, x]) => ({ i, ...x }))
      .filter(x => x.id !== id && (!options.target || x.id === options.target) && x.cnt >= (options.mincnt ?? 0))
      .sort((a, b) => b.value - a.value)
      .map((x, i) => ({ ...x, rank: i + 1 }))
    return list
  }

  async formatAgainst(stats: Tcpt.Against[], title: string = '') {
    if (this.ctx.get('canvas')) return this.formatAgainstCanvas(stats, title)
    else return this.formatAgainstHtml(stats, title)
  }

  async formatAgainstCanvas(stats: Tcpt.Against[], title: string = '') {
    function p(num: number, style: 'percent' | 'decimal' = 'percent'): string {
      return style === 'percent' ? (num * 100).toFixed(2) + '%' : num.toFixed(2)
    }

    const headers = ['排名', '玩家', '仇恨值', '场次', '胜率', '自己平顺', '自己平分', '自己位次', '对手平顺', '对手平分', '对手位次']

    const data = stats.map(x => [x.rank, x.name, x.value, x.cnt, p(x.win / x.cnt, 'percent'),
      p((x.m1 + 2 * x.m2 + 3 * x.m3 + 4 * x.m4) / x.cnt, 'decimal'), p(x.ms / x.cnt, 'decimal'), `${x.m1}/${x.m2}/${x.m3}/${x.m4}`,
      p((x.r1 + 2 * x.r2 + 3 * x.r3 + 4 * x.r4) / x.cnt, 'decimal'), p(x.rs / x.cnt, 'decimal'), `${x.r1}/${x.r2}/${x.r3}/${x.r4}`,
    ].map(x => x.toString()))

    const table = new CanvasTable(this.ctx.canvas.createCanvas(600, (title ? 72 : 48) + 18.5 * data.length) as any, {
      columns: headers.map(x => ({ title: x })),
      data,
      options: {
        header: {
          fontFamily: this.config.fontFamily,
          textAlign: 'center',
        },
        cell: {
          fontFamily: this.config.fontFamily,
          textAlign: 'center',
          padding: 2,
        },
        title: {
          text: title,
          fontFamily: this.config.fontFamily,
          textAlign: 'left',
        },
      },
    })
    await table.generateTable()
    return h.image(await table.renderToBuffer('image/png'), 'image/png')
  }

  async formatAgainstHtml(stats: Tcpt.Against[], title: string = '') {
    function p(num: number, style: 'percent' | 'decimal' = 'percent'): string {
      return style === 'percent' ? (num * 100).toFixed(2) + '%' : num.toFixed(2)
    }

    const headers = ['排名', '玩家', '仇恨值', '场次', '胜率', '自己平顺', '自己平分', '自己位次', '对手平顺', '对手平分', '对手位次']

    const table = `<h2>${title}</h2>
    <table class="gridtable">
        <tr> ${headers.map(x => `<th>${x}</th>`).join('')} </tr>
    ${stats.map(x => `<tr>${[x.rank, x.name, x.value, x.cnt, p(x.win / x.cnt, 'percent'),
    p((x.m1 + 2 * x.m2 + 3 * x.m3 + 4 * x.m4) / x.cnt, 'decimal'), p(x.ms / x.cnt, 'decimal'), `${x.m1}/${x.m2}/${x.m3}/${x.m4}`,
    p((x.r1 + 2 * x.r2 + 3 * x.r3 + 4 * x.r4) / x.cnt, 'decimal'), p(x.rs / x.cnt, 'decimal'), `${x.r1}/${x.r2}/${x.r3}/${x.r4}`,
  ].map(x => `<td>${x}</td>`).join('')}</tr>`).join('\n')}
        `
    return `<html>
        <style type="text/css">
                /* gridtable */
                table.gridtable {
                    font-family: verdana,arial,sans-serif;
                    font-size: 12px;
                    color: #333333;
                    border-width: 1px;
                    border-color: #666666;
                    border-collapse: collapse;
                }

                table.gridtable th {
                    border-width: 1px;
                    padding: 8px;
                    border-style: solid;
                    border-color: #666666;
                    background-color: #dedede;
                }

                table.gridtable td {
                    border-width: 1px;
                    padding: 8px;
                    border-style: solid;
                    border-color: #666666;
                }

                table.gridtable tr:nth-child(even) {
                    background-color: #f2f2f2;
                }

                table.gridtable tr:nth-child(odd) {
                    background-color: #ffffff;
                }

                table.gridtable tr.highlight {
                    background-color: #ffcc33cc;
                }

                table.gridtable tr.lowlight {
                    background-color: #669900cc;
                }

                table.gridtable tr.upgrade {
                    background-color: #ff9999cc;
                }

                table.gridtable tr.downgrade {
                    background-color: #99ff99cc;
                }

                /* /gridtable */
            </style>
        <body>${table}</body></html>`
  }
}

export namespace Tcpt {
  export const inject = {
    required: ['database', 'mahjong', 'mahjong.database'],
    optional: ['canvas'],
  }

  export interface Against {
    id: number
    name: string
    rank: number
    cnt: number
    m1: number
    m2: number
    m3: number
    m4: number
    ms: number
    r1: number
    r2: number
    r3: number
    r4: number
    rs: number
    win: number
    value: number
  }

  export interface Config {
    eloOrigin: number
    lobby: TziakchaLobby.Config
    fontFamily: string
    maxAgainstsTop: number
    maxAgainstsBottom: number
   }

  export const Config: Schema<Config> = Schema.object({
    eloOrigin: Schema.number().default(2000),
    lobby: TziakchaLobby.Config,
    fontFamily: Schema.string().default('Microsoft YaHei, sans-serif'),
    maxAgainstsTop: Schema.number().default(20),
    maxAgainstsBottom: Schema.number().default(10),
  })
}

export default Tcpt
