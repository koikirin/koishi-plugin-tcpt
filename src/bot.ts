import { } from '@cordisjs/timer'
import { mkdir, writeFile } from 'fs/promises'
import { Context, Disposable, isNullable, Logger, Random, Schema, sleep, Time } from 'koishi'
import { solveWaitingTiles } from './utils'
import { inflate } from 'pako'
import { resolve } from 'path'

export class TziakchaBot {
  config: TziakchaBotService.BotConfig & TziakchaBotService.Config
  logger: Logger

  delay: number
  closed = false
  killed = false
  ready = false // killed-restarted bot should wait for next round
  room: TziakchaBot.Status = {}
  status: 'idle' | 'wait' | 'play' = 'idle'

  #wsBot: WebSocket
  #connectBotRetries = 0
  #logs: any[] = []

  #ws: WebSocket
  #heartbeat: Disposable
  #connectRetries = 0
  #lastHeartbeat: number = 0

  constructor(private ctx: Context, globalConfig: TziakchaBotService.Config, botConfig: TziakchaBotService.BotConfig) {
    this.config = {
      ...globalConfig,
      ...botConfig,
    }

    this.logger = ctx.logger.extend(botConfig.name)

    ctx.effect(() => {
      this.connect()
      this.#connectBot().catch(e => {
        this.logger.warn('Failed to connect to bot WebSocket:', e)
      })
      return () => {
        this.closed = true
        try { this.#ws?.close() } finally { this.#ws = null }
        try { this.#wsBot?.close() } finally { this.#ws = null }
      }
    })

    ctx.on('dispose', () => this.flush())
  }

  getStatus(): 'idle' | 'wait' | 'play' | 'closed' | 'killed' | 'connecting' {
    if (this.closed) return 'closed'
    if (this.killed) return 'killed'
    if (this.status === 'play' && !this.ready) return 'killed'
    if (!this.#ws || this.#connectRetries) return 'connecting'
    if (!this.#wsBot || this.#connectBotRetries) return 'connecting'
    return this.status
  }

  connect() {
    try { this.#ws?.close() } catch {}
    this.#ws = this.ctx.http.ws(this.config.serverEndpoint)
    this.#ws.addEventListener('message', this.#receive.bind(this))
    this.#ws.addEventListener('error', (e: ErrorEvent) => {
      if (!e.message.includes('invalid status code')) this.logger.warn(e)
      try { this.#ws?.close() } finally { this.#ws = null }
    })
    this.#ws.addEventListener('close', () => {
      this.logger.info('Disconnect')
      this.status = 'idle'
      try { this.#ws?.close() } finally { this.#ws = null }
      if (!this.closed) {
        const interval = this.config.reconnectIntervals[this.#connectRetries] ?? this.config.reconnectIntervals.at(-1)
        this.logger.info(`Connection closed. will reconnect after ${interval}ms ... (${this.#connectRetries})`)
        this.ctx.setTimeout(this.connect.bind(this), interval)
      }
      this.#connectRetries += 1
    })
    this.#ws.addEventListener('open', async () => {
      this.#connectRetries = 0

      this.#ws.send(JSON.stringify({
        m: 1,
        r: 10,
      }))

      this.logger.info('Connected to server')
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

  async #connectBot() {
    this.killed = false
    this.#wsBot = this.ctx.http.ws(this.config.endpoint ?? this.config.botEndpoint)
    this.#wsBot.addEventListener('message', async (e: MessageEvent) => {
      const packet = JSON.parse(e.data)
      this.logger.debug('Receive from agent: ', packet)
      const meta: TziakchaBot.ResponseMeta = packet._meta ?? {}
      if (meta.t === 'error') {
        this.killed = true
        this.logger.warn('Agent error:', packet)
        return
      } else if (meta.t === 'fatal') {
        this.killed = true
        this.logger.error('Agent fatal error:', packet)
        this.kill()
        return
      }
      this.killed = false
      this.#log({
        ...packet,
        type: 'send',
      })
      if (meta.d !== false) await sleep(this.delay ?? this.config.delay)
      delete packet._meta
      if (this.#ws) this.#ws.send(JSON.stringify(packet))
      else this.killed = true
    })
    this.#wsBot.addEventListener('error', (e: ErrorEvent) => {
      this.logger.warn('Agent error:', e.message)
    })
    this.#wsBot.addEventListener('close', () => {
      this.logger.info('Agent disconnect')
      try { this.#wsBot?.close() } finally { this.#wsBot = null }
      if (!this.closed) {
        const interval = this.config.reconnectIntervals[this.#connectBotRetries] ?? this.config.reconnectIntervals.at(-1)
        this.logger.info(`Connection closed. will reconnect after ${interval}ms ... (${this.#connectBotRetries})`)
        this.ctx.setTimeout(this.#connectBot.bind(this), interval)
      }
      this.#connectBotRetries += 1
    })
    this.#wsBot.addEventListener('open', () => {
      this.logger.info('Connected to agent')
      this.ready = false
      this.#connectBotRetries = 0
    })
  }

  async kill() {
    try { this.#ws?.close() } catch {}
    try { this.#wsBot?.close() } catch {}
  }

  async #log(message: any) {
    this.#logs.push(message)
  }

  async flush() {
    if (this.#logs.length === 0) return
    try {
      const logs = this.#logs.slice()
      this.#logs = []
      await writeFile(resolve(this.ctx.baseDir, 'data', 'tcbot', 'traces', `${this.config.name}-${Date.now()}.log`), JSON.stringify(logs))
      this.logger.info('Trace written successfully')
    } catch (e) {
      this.logger.warn('Failed to write trace:', e)
    }
  }

  async #wait() {
    await new Promise(resolve => setTimeout(resolve, this.config.responseInterval))
  }

  async #login(question: string) {
    this.#ws.send(JSON.stringify({
      m: 1,
      p: this.config.password,
      r: 9,
      s: solveWaitingTiles(question),
      u: this.config.username,
      z: question,
    }))

    await this.#wait()

    this.#ws.send(JSON.stringify({
      m: 1,
      r: 2,
    }))
  }

  async join(roomId: number, seat: number, password?: string) {
    if (this.getStatus() !== 'idle') return false
    this.status = 'wait'
    this.logger.info(`Joining room ${roomId} at seat ${seat + 1}... with password ${password}`)

    this.#ws.send(JSON.stringify({
      m: 1,
      r: 4,
      v: roomId,
      s: seat,
      ...(password ? { p: password } : {}),
    }))
    await this.#wait()

    if (!(this.room.i === roomId)) {
      this.status = 'idle'
      return false
    }

    this.#ws.send(JSON.stringify({
      m: 1,
      r: 6,
      v: 1,
    }))
    return true
  }

  async exit() {
    this.#ws.send(JSON.stringify({
      m: 1,
      r: 5,
    }))
    await this.#wait()

    this.status = 'idle'
  }

  async #receive({ data }: MessageEvent) {
    if (typeof data !== 'string') data = inflate(new Uint8Array(data), { to: 'string' })
    const packet = JSON.parse(data)
    this.logger.debug('Received packet:', packet)
    const op = packet.m
    if (op === 5) {
      if (packet.t === this.#lastHeartbeat) this.#lastHeartbeat = 0
    } else if (op === 1 && packet.r === 1) {
      if (packet.e) this.kill()
    } else if (op === 1 && packet.r === 8) {
      if (packet.t) this.room = packet.t
    } else if (op === 1 && packet.r === 10) {
      this.#login(packet.z)
    } else if (op === 2) {
      // game packets
      if (packet.r === 1) {
        packet._ts = performance.timeOrigin
      }
      if (packet.r === 14) {
        packet._ts = performance.now()
        this.ready = true
        ;(this.room ??= {}).p = packet.v
      } else if (packet.r === 2) {
        packet._ts = performance.now()
      }
      await this.#process(packet)
      if (packet.r === 17) {
        this.status = 'idle'
        this.flush()
      }
    }
  }

  async #process(packet) {
    this.status = 'play'
    if (!this.ready) {
      // bot not ready, we discard everything drawn ?
      if (packet.r === 6 && packet.v === this.room.p) {
        this.#ws.send(JSON.stringify({
          m: 2,
          r: 2,
          v: packet.t & 0xff,
        }))
      } else if (packet.tt) {
        this.#ws.send(JSON.stringify({
          m: 2,
          r: 9,
          v: 0,
        }))
      }
      return
    }
    this.logger.debug('Send to agent:', packet)
    this.#log({
      ...packet,
      type: 'receive',
    })
    this.#wsBot.send(JSON.stringify(packet))
  }
}

export namespace TziakchaBot {
  export interface Status {
    i?: number // room id
    s?: number // seat
    n?: string // name
    v?: number // vip 0/1
    p?: number // seat in game
  }

  export interface ResponseMeta {
    t?: string
    m?: string
    d?: false
  }
}

export class TziakchaBotService {
  static name = 'tcbot'

  bots: TziakchaBot[]

  constructor(private ctx: Context, private config: TziakchaBotService.Config) {
    ctx.on('ready', () => { mkdir(resolve(this.ctx.baseDir, 'data', 'tcbot', 'traces'), { recursive: true }) })

    this.bots = this.config.bots.filter(botConfig => botConfig.enabled).map(botConfig => new TziakchaBot(ctx, this.config, botConfig))

    ctx.command('tcbot')

    const fmtBotStatus = (bot: TziakchaBot) => {
      const status = bot.getStatus()
      switch (status) {
        case 'idle': return `空闲中✅`
        case 'wait': return `准备中⏳`
        case 'play': return `对局中❌`
        case 'closed': return `已断开❌`
        case 'killed': return `已出错❌`
        case 'connecting': return `连接中⏳`
      }
    }

    ctx.command('tcbot.status').action(() => {
      return `- Bots(${this.bots.length})\n` + this.bots.map(bot => `${bot.config.name} ${fmtBotStatus(bot)}`).join('\n')
    })

    ctx.command('tcbot.join <roomPattern:string>')
      .option('bot', '-b <name:string>')
      .option('password', '-p <password:string>')
      .option('num', '-n <num:number>', { fallback: 1 })
      .option('delay', '-d <delay:number>')
      .action(async ({ session, options }, roomPattern) => {
        if (!roomPattern) return session.execute('help tcbot.join')
        let bots: TziakchaBot[]
        if (options.bot) {
          bots = [this.bots.find(bot => bot.config.name === options.bot)]
        } else if (this.config.randomPick) {
          bots = Random.pick(this.bots.filter(bot => bot.getStatus() === 'idle'), options.num)
        } else {
          bots = this.bots.filter(bot => bot.getStatus() === 'idle').slice(0, options.num)
        }
        if (bots.length < options.num) return session.text('.no-available')
        const candidates = Object.values(ctx.tclobby.rooms).filter((room) => !room.start_time && room.title.match(roomPattern))
        if (candidates.length === 0) return session.text('.not-found')
        if (candidates.length > 1) return session.text('.multiple-found')
        const room = candidates[0], seat = room.players.findIndex(x => !x)

        const result = []
        for (const bot of bots) {
          if (await bot.join(room.id, seat, options.password)) {
            bot.delay = options.delay ?? this.config.delay
            result.push(session.text('.success', { room, bot, seat }))
          } else {
            result.push(session.text('.failed', { room, bot }))
            return result.join('\n')
          }
        }
        return result.join('\n')
      })

    ctx.command('tcbot.kick <...names:string>')
      .option('force', '-f', { fallback: false })
      .action(async ({ session, options }, ...names) => {
        const success = []
        await Promise.all(this.bots.map(async bot => {
          if (bot.getStatus() === 'play' && !options.force) return Promise.resolve()
          if (!names?.length || names.includes(bot.config.name)) {
            return bot.exit().then(() => success.push(bot.config.name))
          }
        }))
        if (success.length) return session.text('.success', success)
        else return session.text('.not-found')
      })

    ctx.command('tcbot.delay <delay:number>')
      .option('bot', '-b <name:string>')
      .action(async ({ session, options }, delay) => {
        if (isNullable(delay)) return
        if (options.bot) {
          const bot = this.bots.find(bot => bot.config.name === options.bot)
          if (!bot) return session.text('.not-found')
          bot.delay = delay
          return session.text('.success')
        } else {
          this.bots.forEach(bot => bot.delay = delay)
          return session.text('.success')
        }
      })

    ctx.command('tcbot.reset')
      .action(async ({ session }) => {
        for (const bot of this.bots) {
          bot.status = 'idle'
        }
        return session.text('.success')
      })

    ctx.command('tcbot.kill <...names: string>', { authority: 3 })
      .option('all', '-a', { fallback: false })
      .action(async ({ session, options }, ...names) => {
        if (options.all) {
          for (const bot of this.bots) {
            await bot.kill()
          }
          return session.text('.success')
        } else if (names?.length) {
          const bots = this.bots.filter(bot => names.includes(bot.config.name))
          if (!bots.length) return session.text('.not-found')
          await Promise.all(bots.map(bot => bot.kill()))
          return session.text('.success')
        }
      })

    ctx.command('tcbot.flush', { authority: 3 })
      .action(async ({ session }, name) => {
        await Promise.all(this.bots.map(bot => bot.flush()))
        return session.text('.success')
      })
  }
}

export namespace TziakchaBotService {
  export const inject = ['tclobby']

  export interface BotConfig {
    enabled: boolean
    name: string
    username: string
    password: string
    endpoint?: string
  }

  export const BotConfig: Schema<BotConfig> = Schema.object({
    enabled: Schema.boolean().default(true),
    name: Schema.string(),
    username: Schema.string(),
    password: Schema.string().role('secret'),
    endpoint: Schema.string().required(false),
  })

  export interface Config {
    enabled: boolean
    serverEndpoint: string
    botEndpoint: string
    bots: BotConfig[]
    randomPick: boolean
    reconnectIntervals: number[]
    heartbeatInterval: number
    responseInterval: number
    delay: number
  }

  export const Config: Schema<Config> = Schema.object({
    enabled: Schema.boolean().default(true),
    serverEndpoint: Schema.string().default('wss://tziakcha.net:5334/ws'),
    botEndpoint: Schema.string().default('ws://127.0.0.1:8089/'),
    bots: Schema.array(BotConfig).default([]),
    randomPick: Schema.boolean().default(true),
    reconnectIntervals: Schema.array(Schema.number().role('ms')).default([
      Time.second * 5, Time.second * 10, Time.second * 30,
      Time.minute, Time.minute * 3, Time.minute * 5, Time.minute * 10,
    ]),
    heartbeatInterval: Schema.number().role('ms').default(30000),
    responseInterval: Schema.number().role('ms').default(300),
    delay: Schema.number().role('ms').default(1500),
  })
}

export default TziakchaBotService
