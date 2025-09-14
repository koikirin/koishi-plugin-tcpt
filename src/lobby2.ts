import { } from '@hieuzest/koishi-plugin-mahjong'
import { Context, Dict, Disposable, h, Logger, Schema, Service, Time } from 'koishi'
import { fmtTl, solveWaitingTiles } from './utils'
import { inflate } from 'pako'

declare module 'koishi' {
  interface Context {
    tclobby: TziakchaLobby
  }
}

const logger = new Logger('tcpt.lobby')

interface Player {
  name: string
  vip: number
  // level: number
  // gender: number
  // score: number
}

interface Stats {
  f: number // Idle
  w: number // Waiting
  p: number // Playing
  o: number // Auto
}

interface Room {
  id: number
  create_time: number
  finish_time: number
  title: string
  rd_idx: number
  rd_cnt: number
  players: Player[]
  g: any
  password: boolean
  start_time?: number
}

export function formatTimeLimits(doc: any, limits: boolean = false) {
  return fmtTl(doc.g.r0, doc.g.r1, doc.g.e, limits ? doc.g.l : 0)
}

function formatWaitingRoom(room: Room) {
  return `${room.password ? '🔒' : ''}[${formatTimeLimits(room)}] ${room.title} (${room.players.map(x => x?.name ?? '').join(', ')})`
}

function formatPlayingRoom(room: Room) {
  return `[${room.rd_idx}/${room.rd_cnt}] ${room.title} (${room.players.map(x => x?.name ?? '').join(', ')})`
}

export class TziakchaLobby extends Service {
  closed = false
  rooms: Dict<Room> = {}
  stats: Stats = { f: 0, w: 0, p: 0, o: 0 }

  #ws: WebSocket
  #heartbeat: Disposable
  #connectRetries = 0
  #lastHeartbeat: number = 0

  constructor(ctx: Context, public config: TziakchaLobby.Config) {
    super(ctx, 'tclobby')

    ctx.command('tcpt/tclobby2 [pattern:string]')
      .option('wait', '-w')
      .option('play', '-p')
      .option('bind', '-b')
      .userFields(['tclobby/bind'])
      .action(({ session, options }, pattern) => {
        if (options.bind) session.user['tclobby/bind'] = pattern ?? ''
        pattern ||= session.user['tclobby/bind']
        const wait = h.text(`- ${session.text('.wait')}[${this.stats.f}/${this.stats.w}]：\n`
          + Object.values(this.rooms).filter(x => (!pattern || x.title.includes(pattern)) && !x.start_time).map(formatWaitingRoom).join('\n'))
        const play = h.text(`- ${session.text('.play')}[${(this.stats.p + this.stats.o) / 4}]：\n`
          + Object.values(this.rooms).filter(x => (!pattern || x.title.includes(pattern)) && x.start_time).map(formatPlayingRoom).join('\n'))
        if (options.wait && options.play) return wait + '\n' + play
        if (options.wait) return wait
        else if (options.play) return play
        else return wait + '\n' + play
      })

    ctx.on('ready', async () => {
      ctx.effect(() => {
        this.connect()
        return () => {
          this.closed = true
          try { this.#ws?.close() } finally { this.#ws = null }
        }
      })
    })
  }

  connect() {
    try { this.#ws?.close() } catch {}
    this.#ws = this.ctx.http.ws(this.config.endpoint)
    this.#ws.addEventListener('message', this.#receive.bind(this))
    this.#ws.addEventListener('error', (e: ErrorEvent) => {
      if (!e.message.includes('invalid status code')) logger.warn(e)
      try { this.#ws?.close() } finally { this.#ws = null }
    })
    this.#ws.addEventListener('close', () => {
      logger.info('Disconnect')
      try { this.#ws?.close() } finally { this.#ws = null }
      if (!this.closed) {
        const interval = this.config.reconnectIntervals[this.#connectRetries] ?? this.config.reconnectIntervals.at(-1)
        logger.info(`Connection closed. will reconnect after ${interval}ms ... (${this.#connectRetries})`)
        this.ctx.setTimeout(this.connect.bind(this), interval)
      }
      this.#connectRetries += 1
    })
    this.#ws.addEventListener('open', async () => {
      this.#connectRetries = 0
      this.rooms = {}

      this.#ws.send(JSON.stringify({
        'm': 1,
        'r': 10,
      }))

      logger.info('Connected to server')
    })

    this.#heartbeat?.()
    this.#lastHeartbeat = 0
    this.#heartbeat = this.ctx.setInterval(() => {
      if (!this.closed && this.#ws) {
        try {
          if (this.#lastHeartbeat) {
            this.#ws.close()
            return
          }
          this.#lastHeartbeat = Date.now()
          this.#ws.send(JSON.stringify({
            m: 5,
            t: this.#lastHeartbeat,
          }))
        } catch {}
      }
    }, this.config.heartbeatInterval)
  }

  async #login(question: string) {
    this.#ws.send(JSON.stringify({
      'm': 1,
      'p': this.config.password,
      'r': 9,
      's': solveWaitingTiles(question),
      'u': this.config.username,
      'z': question,
    }))

    await new Promise(resolve => setTimeout(resolve, 300))

    this.#ws.send(JSON.stringify({
      m: 1,
      r: 2,
    }))
  }

  packRoom(data: any) {
    const res: Room = {
      id: data.i,
      create_time: data.t,
      finish_time: data.e,
      title: data.g.t,
      rd_idx: data.n - 1,
      rd_cnt: data.g.n,
      players: [],
      g: data.g,
      password: data.u,
    }
    data.p.forEach(p => {
      if (p && Object.values(p).length) {
        res.players.push({
          name: p.n,
          vip: p.v ?? 0,
        })
      } else {
        res.players.push(null)
      }
    })

    this.rooms[res.id] = res
    if (data.n === 0) {
      logger.debug(`Wait: ${res.title} ${res.players.map(x => x?.name).join(', ')}`)
    } else {
      res.start_time = Date.now()
      logger.debug(`Play: ${res.title}`)
    }
  }

  joinRoom(data) {
    let id = data.t.i
    if (id in this.rooms) {
      this.rooms[id].players[data.t.s] = {
        name: data.t.n,
        vip: data.t.v ?? 0,
      }
    }
    if (!data.f) return
    id = data.f.i
    if (id in this.rooms) {
      this.rooms[id].players[data.f.s] = null
    }
  }

  exitRoom(data) {
    const id = data.t.i
    if (id in this.rooms) {
      this.rooms[id].players[data.t.s] = null
    }
  }

  dismissRoom(data) {
    const id = data.t.i
    if (id in this.rooms) {
      logger.debug(`Dismiss: ${this.rooms[id].title}`)
      delete this.rooms[id]
    }
  }

  startRoom(data) {
    const id = data.i
    if (id in this.rooms) {
      if (this.rooms[id].players.every(x => x)) {
        this.rooms[id].rd_idx = 0
        this.rooms[id].start_time = Date.now()
        logger.debug(`Start: ${this.rooms[id].title}`)
        // delete this.rooms[data.t.i]
      }
    }
  }

  updateRoom(data) {
    const id = data.i
    if (id in this.rooms) {
      this.rooms[id].rd_idx = data.p
    }
  }

  #receive({ data }: MessageEvent) {
    if (typeof data !== 'string') data = inflate(new Uint8Array(data), { to: 'string' })
    const packet = JSON.parse(data)
    const op = packet.m
    if (packet.s?.f !== undefined) this.stats = packet.s
    if (op === 5) {
      if (packet.t === this.#lastHeartbeat) this.#lastHeartbeat = 0
    } else if (op === 1 && packet.r === 1) {
      // Login callback
    } else if (op === 1 && packet.r === 2) {
      (packet.t ?? []).forEach(this.packRoom.bind(this))
    } else if (op === 1 && packet.r === 3) {
      (packet.t ?? []).forEach(this.packRoom.bind(this))
    } else if (op === 1 && packet.r === 4) {
      this.joinRoom(packet)
    } else if (op === 1 && packet.r === 5) {
      this.exitRoom(packet)
    } else if (op === 1 && packet.r === 6) {
      // Ready
    } else if (op === 1 && packet.r === 7) {
      this.dismissRoom(packet)
    } else if (op === 1 && packet.r === 8) {
      // Stats update
    } else if (op === 1 && packet.r === 9) {
      // Login user info
    } else if (op === 1 && packet.r === 10) {
      this.#login(packet.z)
    } else if (op === 1 && packet.r === 13) {
      if (packet.p === 1) this.startRoom(packet)
      else this.updateRoom(packet)
    } else {
      logger.warn(packet)
    }
  }
}

export namespace TziakchaLobby {
  export const using = ['mahjong']

  export interface Config {
    endpoint: string
    username?: string
    password?: string
    reconnectIntervals: number[]
    heartbeatInterval: number
    idleOffset: number
  }

  export const Config: Schema<Config> = Schema.object({
    endpoint: Schema.string().default('wss://tziakcha.net:5334/ws'),
    username: Schema.string().required(false),
    password: Schema.string().role('secret').required(false),
    reconnectIntervals: Schema.array(Schema.number().role('ms')).default([
      Time.second * 5, Time.second * 10, Time.second * 30,
      Time.minute, Time.minute * 3, Time.minute * 5, Time.minute * 10,
    ]),
    heartbeatInterval: Schema.number().role('ms').default(30000),
    idleOffset: Schema.natural().default(1),
  })
}

export default TziakchaLobby
