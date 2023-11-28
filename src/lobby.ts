import { } from '@hieuzest/koishi-plugin-mahjong'
import { Context, Dict, Disposable, Logger, Schema } from 'koishi'
import { WebSocket } from 'ws'
import { formatTimeLimits } from './utils'

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
  start_time?: number
}

function formatWaitingRoom(room: Room) {
  return `[${formatTimeLimits(room)}] ${room.title} (${room.players.map(x => x?.name ?? '').join(', ')})`
}

function formatPlayingRoom(room: Room) {
  return `[${room.rd_idx}/${room.rd_cnt}] ${room.title} (${room.players.map(x => x?.name ?? '').join(', ')})`
}

export class TziakchaLobby {
  closed = false
  rooms: Dict<Room> = {}
  stats: Stats = { f: 0, w: 0, p: 0, o: 0 }

  #ws: WebSocket
  #heartbeat: Disposable
  #connectRetries = 0
  #lastHeartbeat: number = 0

  constructor(private ctx: Context, private config: TziakchaLobby.Config) {
    ctx.command('tcpt/tcwait', '查看待机')
      .action(() => {
        return `- 大厅[${this.stats.f}/${this.stats.w}]：\n` + Object.values(this.rooms).filter(x => !x.start_time).map(formatWaitingRoom).join('\n')
      })

    ctx.command('tcpt/tcplay', '查看对局')
      .action(() => {
        return `- 对局[${(this.stats.p + this.stats.o) / 4}]：\n` + Object.values(this.rooms).filter(x => x.start_time).map(formatPlayingRoom).join('\n')
      })

    ctx.command('tcpt/tclobby', '查看大厅')
      .action(() => {
        return `- 大厅[${this.stats.f}/${this.stats.w}]：\n` + Object.values(this.rooms).filter(x => !x.start_time).map(formatWaitingRoom).join('\n') + '\n'
        + `- 对局[${(this.stats.p + this.stats.o) / 4}]：\n` + Object.values(this.rooms).filter(x => x.start_time).map(formatPlayingRoom).join('\n')
      })

    ctx.on('ready', async () => {
      this.connect()
    })

    ctx.collect('ws', () => {
      this.closed = true
      this.#ws?.close()
      this.#ws = null
    })
  }

  connect() {
    this.#ws?.close()
    this.#ws = this.ctx.http.ws('ws://www.tziakcha.xyz:5333/ws')
    this.#ws.on('message', this.#receive.bind(this))
    this.#ws.on('error', (e) => {
      if (!e.message.includes('invalid status code')) logger.warn(e)
      this.#ws?.close()
      this.#ws = null
      this.#connectRetries += 1
      if (this.#connectRetries > this.config.reconnectTimes) {
        logger.warn('Error occurs and exceed max retries')
      } else if (!this.closed) {
        this.ctx.setTimeout(this.connect.bind(this), this.config.reconnectInterval)
      }
    })
    this.#ws.on('close', () => {
      logger.info('Disconnect')
      this.#ws?.close()
      this.#ws = null
      this.#connectRetries += 1

      if (this.#connectRetries > this.config.reconnectTimes) {
        logger.warn('Exceed max retries')
      } else if (!this.closed) {
        logger.info(`Connection closed. will reconnect... (${this.#connectRetries})`)
        this.ctx.setTimeout(this.connect.bind(this), this.config.reconnectInterval)
      }
    })
    this.#ws.on('open', async () => {
      this.#ws.send(JSON.stringify({
        'm': 1,
        'p': this.config.password,
        'r': 9,
        's': '',
        'u': this.config.username,
        'z': '',
      }))

      await new Promise(resolve => setTimeout(resolve, 500))

      this.#ws.send(JSON.stringify({
        m: 1,
        r: 2,
      }), (e) => e || logger.info('Connected to server'))
    })

    this.#heartbeat?.()
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
    }
    data.p.forEach(p => {
      if (p) {
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
      logger.debug(`Wait: ${res.title} ${res.players.map(x => x.name).join(', ')}`)
    } else {
      res.start_time = Date.now()
      logger.debug(`Play: ${res.title}`)
    }
  }

  joinRoom(data) {
    if (data.t.i in this.rooms) {
      this.rooms[data.t.i].players[data.t.s] = {
        name: data.t.n,
        vip: data.t.v ?? 0,
      }
    }
  }

  exitRoom(data) {
    if (data.t.i in this.rooms) {
      this.rooms[data.t.i].players[data.t.s] = null
    }
  }

  dismissRoom(data) {
    if (data.t.i in this.rooms) {
      logger.debug(`Dismiss: ${this.rooms[data.t.i].title}`)
      delete this.rooms[data.t.i]
    }
  }

  startRoom(data) {
    if (data.t.i in this.rooms) {
      if (this.rooms[data.t.i].players.every(x => x)) {
        this.rooms[data.t.i].rd_idx = 0
        this.rooms[data.t.i].start_time = Date.now()
        logger.debug(`Start: ${this.rooms[data.t.i].title}`)
        // delete this.rooms[data.t.i]
      }
    }
  }

  updateRoom(data) {
    if (data.t.i in this.rooms) {
      this.rooms[data.t.i].rd_idx = data.p
    }
  }

  #receive(data: any) {
    const packet = JSON.parse(data)
    const op = packet.m
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
      if (packet.s) this.stats = packet.s
    } else if (op === 1 && packet.r === 8) {
      this.stats = packet.s
    } else if (op === 1 && packet.r === 13) {
      if (packet.p === 1) this.startRoom(packet)
      else this.updateRoom(packet)
    } else {
      logger.debug(packet)
    }
  }
}

export namespace TziakchaLobby {
  export const using = ['mahjong']

  export interface Config {
    username: string
    password: string
    reconnectTimes: number
    reconnectInterval: number
    heartbeatInterval: number
    idleOffset: number
  }

  export const Config: Schema<Config> = Schema.object({
    username: Schema.string(),
    password: Schema.string().role('secret'),
    reconnectTimes: Schema.number().default(10),
    reconnectInterval: Schema.number().role('ms').default(60000),
    heartbeatInterval: Schema.number().role('ms').default(30000),
    idleOffset: Schema.number().default(1),
  })
}

export default TziakchaLobby
