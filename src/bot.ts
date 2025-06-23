import { } from '@cordisjs/timer'
import { mkdir, writeFile } from 'fs/promises'
import { Context, Disposable, isNullable, Logger, Schema, sleep, Time } from 'koishi'
import { solveWaitingTiles } from './utils'
import { inflate } from 'pako'
import { resolve } from 'path'

export class TziakchaBot {
  config: TziakchaBotService.BotConfig & TziakchaBotService.Config
  logger: Logger

  closed = false
  killed = false
  room: TziakchaBot.Status = {}
  status: 'idle' | 'wait' | 'play' = 'idle'

  #ws: WebSocket
  #wsBot: WebSocket
  #heartbeat: Disposable
  #connectRetries = 0
  #lastHeartbeat: number = 0
  #logs: any[] = []

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

  connect() {
    try { this.#ws?.close() } catch {}
    this.#ws = this.ctx.http.ws(this.config.endpoint)
    this.#ws.addEventListener('message', this.#receive.bind(this))
    this.#ws.addEventListener('error', (e: ErrorEvent) => {
      if (!e.message.includes('invalid status code')) this.logger.warn(e)
      try { this.#ws?.close() } finally { this.#ws = null }
    })
    this.#ws.addEventListener('close', () => {
      this.logger.info('Disconnect')
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
    this.#wsBot = this.ctx.http.ws(this.config.botEndpoint)
    this.#wsBot.addEventListener('open', () => {
      this.logger.info('Connected to agent')
    })
    this.#wsBot.addEventListener('message', async (e: MessageEvent) => {
      const packet = JSON.parse(e.data)
      this.logger.debug('Receive from agent: ', packet)
      this.#log({
        ...packet,
        type: 'send',
      })
      if (packet.type === 'error') {
        this.killed = true
        this.logger.warn('Agent error:', packet)
        return
      }
      await sleep(this.config.delay)
      this.#ws.send(e.data)
    })
    this.#wsBot.addEventListener('error', (e: ErrorEvent) => {
      this.logger.warn('Agent error:', e.message)
    })
    this.#wsBot.addEventListener('close', () => {
      this.logger.info('Disconnect')
      try { this.#wsBot?.close() } finally { this.#ws = null }
      if (!this.closed) {
        const interval = this.config.reconnectIntervals[this.#connectRetries] ?? this.config.reconnectIntervals.at(-1)
        this.logger.info(`Connection closed. will reconnect after ${interval}ms ... (${this.#connectRetries})`)
        this.ctx.setTimeout(this.#connectBot.bind(this), interval)
      }
      this.#connectRetries += 1
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
      await writeFile(resolve(this.ctx.baseDir, 'data', 'tcbot', 'traces', `${this.config.name}-${Date.now()}.log`), JSON.stringify(logs, null, 2))
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

    if (!(this.room.i === roomId && this.room.s === seat)) {
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
    } else if (op === 1 && packet.r === 8) {
      if (packet.t) this.room = packet.t
    } else if (op === 1 && packet.r === 10) {
      this.#login(packet.z)
    } else if (op === 2) {
      // game packets
      await this.#process(packet)
      if (packet.r === 17) {
        this.status = 'idle'
        this.flush()
      }
    }
  }

  async #process(packet) {
    this.status = 'play'
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
  }
}

export class TziakchaBotService {
  bots: TziakchaBot[]

  constructor(private ctx: Context, private config: TziakchaBotService.Config) {
    ctx.on('ready', () => { mkdir(resolve(this.ctx.baseDir, 'data', 'tcbot', 'traces'), { recursive: true }) })

    this.bots = this.config.bots.map(botConfig => new TziakchaBot(ctx, this.config, botConfig))

    ctx.command('tcbot')

    const fmtBotStatus = (bot: TziakchaBot) => {
      if (bot.killed) return `已出错❌`
      else if (bot.status === 'idle') return `空闲中✅`
      else if (bot.status === 'wait') return `准备中⏳`
      else if (bot.status === 'play') return `对局中❌`
      else return `未知❓`
    }

    ctx.command('tcbot.status').action(() => {
      return this.bots.map(bot => `${bot.config.name} ${fmtBotStatus(bot)}`).join('\n')
    })

    ctx.command('tcbot.join <roomPattern:string>')
      .option('password', '-p <password:string>')
      .action(async ({ session, options }, roomPattern) => {
        if (!roomPattern) return session.execute('help tcbot.join')
        const bot = this.bots.find(bot => bot.status === 'idle')
        if (!bot) return session.text('.no-available')
        const candidates = Object.values(ctx.tclobby.rooms).filter((room) => !room.start_time && room.title.match(roomPattern))
        if (candidates.length === 0) return session.text('.not-found')
        if (candidates.length > 1) return session.text('.multiple-found')
        const room = candidates[0], seat = room.players.findIndex(x => !x)
        if (await bot.join(room.id, seat, options.password)) {
          return session.text('.success', { room, bot, seat })
        } else {
          return session.text('.failed', { room, bot })
        }
      })

    ctx.command('tcbot.kick <name:string>')
      .action(async ({ session }, name) => {
        if (isNullable(name)) {
          for (const bot of this.bots) {
            if (bot.status === 'wait') {
              await bot.exit()
            }
          }
          return session.text('.success-all')
        } else {
          const bot = this.bots.find(bot => bot.config.name === name)
          if (!bot || bot.status !== 'wait') return session.text('.not-found')
          await bot.exit()
          return session.text('.success')
        }
      })

    ctx.command('tcbot.reset')
      .action(async ({ session }) => {
        for (const bot of this.bots) {
          bot.status = 'idle'
        }
        return 'Success'
      })

    ctx.command('tcbot.kill', { authority: 3 })
      .action(async ({ session }, name) => {
        const bot = this.bots.find(bot => bot.config.name === name)
        await bot.kill()
        return 'Success'
      })

    ctx.command('tcbot.flush', { authority: 3 })
      .action(async ({ session }, name) => {
        await Promise.all(this.bots.map(bot => bot.flush()))
        return 'Success'
      })
  }
}

export namespace TziakchaBotService {
  export const inject = ['tclobby']

  export interface BotConfig {
    name: string
    username: string
    password: string
  }

  export const BotConfig: Schema<BotConfig> = Schema.object({
    name: Schema.string(),
    username: Schema.string(),
    password: Schema.string().role('secret'),
  })

  export interface Config {
    endpoint: string
    botEndpoint: string
    bots: BotConfig[]
    reconnectIntervals: number[]
    heartbeatInterval: number
    responseInterval: number
    delay: number
  }

  export const Config: Schema<Config> = Schema.object({
    endpoint: Schema.string().default('wss://tziakcha.net:5334/ws'),
    botEndpoint: Schema.string().default('ws://127.0.0.1:8089/'),
    bots: Schema.array(BotConfig).default([]),
    reconnectIntervals: Schema.array(Schema.number().role('ms')).default([
      Time.second * 5, Time.second * 10, Time.second * 30,
      Time.minute, Time.minute * 3, Time.minute * 5, Time.minute * 10,
    ]),
    heartbeatInterval: Schema.number().role('ms').default(30000),
    responseInterval: Schema.number().role('ms').default(300),
    delay: Schema.number().role('ms').default(1000),
  })
}

export default TziakchaBotService
