// File: src/services/player.ts

import {
  AudioPlayer,
  AudioPlayerState,
  AudioPlayerStatus,
  AudioResource,
  createAudioPlayer,
  createAudioResource,
  DiscordGatewayAdapterCreator,
  joinVoiceChannel,
  StreamType,
  VoiceConnection,
  VoiceConnectionState,
  VoiceConnectionStatus,
} from '@discordjs/voice'
import ytdl, { videoFormat } from '@distube/ytdl-core'
import shuffle from 'array-shuffle'
import { Snowflake, VoiceChannel } from 'discord.js'
import ffmpeg from 'fluent-ffmpeg'
import { WriteStream } from 'fs-capacitor'
import hasha from 'hasha'
import { Readable } from 'stream'
import { WritableStream } from 'stream/web'
import { buildPlayingMessageEmbed } from '../utils/build-embed.js'
import debug from '../utils/debug.js'
import { getGuildSettings } from '../utils/get-guild-settings.js'
import FileCacheProvider from './file-cache.js'

// Updated interfaces
interface Setting {
  turnDownVolumeWhenPeopleSpeak?: boolean
  turnDownVolumeWhenPeopleSpeakTarget?: number
  secondsToWaitAfterQueueEmpties?: number
  autoAnnounceNextSong?: boolean
  defaultVolume?: number
}

interface NetworkState {
  udp?: {
    keepAliveInterval?: NodeJS.Timeout
  }
}

interface NetworkStateChange {
  networking?: {
    on(
      event: 'stateChange',
      handler: (oldState: unknown, newState: NetworkState) => void,
    ): void
    off(
      event: 'stateChange',
      handler: (oldState: unknown, newState: NetworkState) => void,
    ): void
  }
  status?: VoiceConnectionStatus
}

// Rest of your type definitions
export enum MediaSource {
  Youtube,
  HLS,
}

export interface QueuedPlaylist {
  title: string
  source: string
}

export interface SongMetadata {
  title: string
  artist: string
  url: string // For YT, it's the video ID (not the full URI)
  length: number
  offset: number
  playlist: QueuedPlaylist | null
  isLive: boolean
  thumbnailUrl: string | null
  source: MediaSource
}

export interface QueuedSong extends SongMetadata {
  addedInChannelId: Snowflake
  requestedBy: string
}

export enum STATUS {
  PLAYING,
  PAUSED,
  IDLE,
}

export interface PlayerEvents {
  statusChange: (oldStatus: STATUS, newStatus: STATUS) => void
}

type YTDLVideoFormat = videoFormat & { loudnessDb?: number }

export const DEFAULT_VOLUME = 100

export default class {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [x: string]: any
  // Your class properties stay the same
  public voiceConnection: VoiceConnection | null = null
  public status = STATUS.PAUSED
  public guildId: string
  public loopCurrentSong = false
  public loopCurrentQueue = false
  private currentChannel: VoiceChannel | undefined
  private queue: QueuedSong[] = []
  private queuePosition = 0
  private audioPlayer: AudioPlayer | null = null
  private audioResource: AudioResource | null = null
  private volume?: number
  private defaultVolume: number = DEFAULT_VOLUME
  private nowPlaying: QueuedSong | null = null
  private playPositionInterval: NodeJS.Timeout | undefined
  private lastSongURL = ''
  private positionInSeconds = 0
  private readonly fileCache: FileCacheProvider
  private disconnectTimer: NodeJS.Timeout | null = null
  private readonly channelToSpeakingUsers: Map<string, Set<string>> = new Map()

  constructor(fileCache: FileCacheProvider, guildId: string) {
    this.fileCache = fileCache
    this.guildId = guildId
  }

  async connect(channel: VoiceChannel): Promise<void> {
    const settings = await getGuildSettings(this.guildId)
    const { defaultVolume = DEFAULT_VOLUME } = settings
    this.defaultVolume = defaultVolume

    this.voiceConnection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      selfDeaf: false,
      adapterCreator: channel.guild
        .voiceAdapterCreator as DiscordGatewayAdapterCreator,
    })

    const guildSettings = await getGuildSettings(this.guildId)

    // Fixed stateChange event handler
    this.voiceConnection.on(
      'stateChange',
      (oldState: VoiceConnectionState, newState: VoiceConnectionState) => {
        const oldNetworking = Reflect.get(oldState, 'networking')
        const newNetworking = Reflect.get(newState, 'networking')

        const networkStateChangeHandler = (
          _oldNetState: unknown,
          newNetworkState: NetworkState,
        ) => {
          const newUdp = Reflect.get(newNetworkState, 'udp')
          if (newUdp?.keepAliveInterval) {
            clearInterval(newUdp.keepAliveInterval)
          }
        }

        if (oldNetworking) {
          oldNetworking.off('stateChange', networkStateChangeHandler)
        }
        if (newNetworking) {
          newNetworking.on('stateChange', networkStateChangeHandler)
        }

        this.currentChannel = channel
        if (newState.status === VoiceConnectionStatus.Ready) {
          this.registerVoiceActivityListener(guildSettings)
        }
      },
    )
  }

  // Updated suppressVoiceWhenPeopleAreSpeaking method
  suppressVoiceWhenPeopleAreSpeaking(
    turnDownVolumeWhenPeopleSpeakTarget: number | undefined,
  ): void {
    if (
      !this.currentChannel ||
      turnDownVolumeWhenPeopleSpeakTarget === undefined
    ) {
      return
    }

    const speakingUsers = this.channelToSpeakingUsers.get(
      this.currentChannel.id,
    )
    if (speakingUsers && speakingUsers.size > 0) {
      this.setVolume(turnDownVolumeWhenPeopleSpeakTarget)
    } else {
      this.setVolume(this.defaultVolume)
    }
  }

  // Updated registerVoiceActivityListener method
  registerVoiceActivityListener(guildSettings: Setting): void {
    const {
      turnDownVolumeWhenPeopleSpeak,
      turnDownVolumeWhenPeopleSpeakTarget,
    } = guildSettings

    if (!turnDownVolumeWhenPeopleSpeak || !this.voiceConnection) {
      return
    }

    this.voiceConnection.receiver.speaking.on('start', (userId: string) => {
      if (!this.currentChannel) {
        return
      }

      const member = this.currentChannel.members.get(userId)
      const channelId = this.currentChannel?.id

      if (member) {
        if (!this.channelToSpeakingUsers.has(channelId)) {
          this.channelToSpeakingUsers.set(channelId, new Set())
        }

        this.channelToSpeakingUsers.get(channelId)?.add(member.id)
      }

      if (turnDownVolumeWhenPeopleSpeakTarget !== undefined) {
        this.suppressVoiceWhenPeopleAreSpeaking(
          turnDownVolumeWhenPeopleSpeakTarget,
        )
      }
    })

    this.voiceConnection.receiver.speaking.on('end', (userId: string) => {
      if (!this.currentChannel) {
        return
      }

      const member = this.currentChannel.members.get(userId)
      const channelId = this.currentChannel.id
      if (member) {
        if (!this.channelToSpeakingUsers.has(channelId)) {
          this.channelToSpeakingUsers.set(channelId, new Set())
        }

        this.channelToSpeakingUsers.get(channelId)?.delete(member.id)
      }

      if (turnDownVolumeWhenPeopleSpeakTarget !== undefined) {
        this.suppressVoiceWhenPeopleAreSpeaking(
          turnDownVolumeWhenPeopleSpeakTarget,
        )
      }
    })
  }

  canGoForward(skip: number) {
    return this.queuePosition + skip - 1 < this.queue.length
  }

  manualForward(skip: number): void {
    if (this.canGoForward(skip)) {
      this.queuePosition += skip
      this.positionInSeconds = 0
      this.stopTrackingPosition()
    } else {
      // throw new Error('No songs in queue to forward to.');
      // send a message to the channel that the queue has ended
      this.currentChannel?.send('Queue has ended')
    }
  }

  canGoBack() {
    return this.queuePosition - 1 >= 0
  }

  async back(): Promise<void> {
    if (this.canGoBack()) {
      this.queuePosition--
      this.positionInSeconds = 0
      this.stopTrackingPosition()

      if (this.status !== STATUS.PAUSED) {
        await this.play()
      }
    } else {
      throw new Error('No songs in queue to go back to.')
    }
  }

  getCurrent(): QueuedSong | null {
    if (this.queue[this.queuePosition]) {
      return this.queue[this.queuePosition]
    }

    return null
  }

  /**
   * Returns queue, not including the current song.
   * @returns {QueuedSong[]}
   */
  getQueue(): QueuedSong[] {
    return this.queue.slice(this.queuePosition + 1)
  }

  add(song: QueuedSong, { immediate = false } = {}): void {
    if (song.playlist || !immediate) {
      // Add to end of queue
      this.queue.push(song)
    } else {
      // Add as the next song to be played
      const insertAt = this.queuePosition + 1
      this.queue = [
        ...this.queue.slice(0, insertAt),
        song,
        ...this.queue.slice(insertAt),
      ]
    }
  }

  shuffle(): void {
    const shuffledSongs = shuffle(this.queue.slice(this.queuePosition + 1))

    this.queue = [
      ...this.queue.slice(0, this.queuePosition + 1),
      ...shuffledSongs,
    ]
  }

  clear(): void {
    const newQueue = []

    // Don't clear curently playing song
    const current = this.getCurrent()

    if (current) {
      newQueue.push(current)
    }

    this.queuePosition = 0
    this.queue = newQueue
  }

  removeFromQueue(index: number, amount = 1): void {
    this.queue.splice(this.queuePosition + index, amount)
  }

  removeCurrent(): void {
    this.queue = [
      ...this.queue.slice(0, this.queuePosition),
      ...this.queue.slice(this.queuePosition + 1),
    ]
  }

  queueSize(): number {
    return this.getQueue().length
  }

  isQueueEmpty(): boolean {
    return this.queueSize() === 0
  }

  stop(): void {
    this.disconnect()
    this.queuePosition = 0
    this.queue = []
  }

  move(from: number, to: number): QueuedSong {
    if (from > this.queueSize() || to > this.queueSize()) {
      throw new Error('Move index is outside the range of the queue.')
    }

    this.queue.splice(
      this.queuePosition + to,
      0,
      this.queue.splice(this.queuePosition + from, 1)[0],
    )

    return this.queue[this.queuePosition + to]
  }

  setVolume(level: number): void {
    // Level should be a number between 0 and 100 = 0% => 100%
    this.volume = level
    this.setAudioPlayerVolume(level)
  }

  getVolume(): number {
    // Only use default volume if player volume is not already set (in the event of a reconnect we shouldn't reset)
    return this.volume ?? this.defaultVolume
  }

  private getHashForCache(url: string): string {
    return hasha(url)
  }

  private async getStream(
    song: QueuedSong,
    options: { seek?: number; to?: number } = {},
  ): Promise<Readable> {
    if (this.status === STATUS.PLAYING) {
      this.audioPlayer?.stop()
    } else if (this.status === STATUS.PAUSED) {
      this.audioPlayer?.stop(true)
    }

    if (song.source === MediaSource.HLS) {
      return this.createReadStream({ url: song.url, cacheKey: song.url })
    }

    let ffmpegInput: string | null
    const ffmpegInputOptions: string[] = []
    let shouldCacheVideo = false

    let format: YTDLVideoFormat | undefined

    ffmpegInput = await this.fileCache.getPathFor(
      this.getHashForCache(song.url),
    )

    if (!ffmpegInput) {
      // Not yet cached, must download
      const info = await ytdl.getInfo(song.url)

      const formats = info.formats as YTDLVideoFormat[]

      const filter = (format: ytdl.videoFormat): boolean =>
        format.codecs === 'opus' &&
        format.container === 'webm' &&
        format.audioSampleRate !== undefined &&
        parseInt(format.audioSampleRate, 10) === 48000

      format = formats.find(filter)

      const nextBestFormat = (
        formats: ytdl.videoFormat[],
      ): ytdl.videoFormat | undefined => {
        if (formats[0].isLive) {
          formats = formats.sort(
            (a, b) =>
              (b as unknown as { audioBitrate: number }).audioBitrate -
              (a as unknown as { audioBitrate: number }).audioBitrate,
          ) // Bad typings

          return formats.find((format) =>
            [128, 127, 120, 96, 95, 94, 93].includes(
              parseInt(format.itag as unknown as string, 10),
            ),
          ) // Bad typings
        }

        formats = formats
          .filter((format) => format.averageBitrate)
          .sort((a, b) => {
            if (a && b) {
              return b.averageBitrate! - a.averageBitrate!
            }

            return 0
          })
        return formats.find((format) => !format.bitrate) ?? formats[0]
      }

      if (!format) {
        format = nextBestFormat(info.formats)

        if (!format) {
          // If still no format is found, throw
          throw new Error("Can't find suitable format.")
        }
      }

      debug('Using format', format)

      ffmpegInput = format.url

      // Don't cache livestreams or long videos
      const MAX_CACHE_LENGTH_SECONDS = 30 * 60 // 30 minutes
      shouldCacheVideo =
        !info.player_response.videoDetails.isLiveContent &&
        parseInt(info.videoDetails.lengthSeconds, 10) <
          MAX_CACHE_LENGTH_SECONDS &&
        !options.seek

      debug(shouldCacheVideo ? 'Caching video' : 'Not caching video')

      ffmpegInputOptions.push(
        ...[
          '-reconnect',
          '1',
          '-reconnect_streamed',
          '1',
          '-reconnect_delay_max',
          '5',
        ],
      )
    }

    if (options.seek) {
      ffmpegInputOptions.push('-ss', options.seek.toString())
    }

    if (options.to) {
      ffmpegInputOptions.push('-to', options.to.toString())
    }

    return this.createReadStream({
      url: ffmpegInput,
      cacheKey: song.url,
      ffmpegInputOptions,
      cache: shouldCacheVideo,
      volumeAdjustment: format?.loudnessDb
        ? `${-format.loudnessDb}dB`
        : undefined,
    })
  }

  private startTrackingPosition(initalPosition?: number): void {
    if (initalPosition !== undefined) {
      this.positionInSeconds = initalPosition
    }

    if (this.playPositionInterval) {
      clearInterval(this.playPositionInterval)
    }

    this.playPositionInterval = setInterval(() => {
      this.positionInSeconds++
    }, 1000)
  }

  private stopTrackingPosition(): void {
    if (this.playPositionInterval) {
      clearInterval(this.playPositionInterval)
    }
  }

  private attachListeners(): void {
    if (!this.voiceConnection) {
      return
    }

    if (
      this.voiceConnection?.state.status !== VoiceConnectionStatus.Disconnected
    ) {
      this.voiceConnection.on(
        VoiceConnectionStatus.Disconnected,
        this.onVoiceConnectionDisconnect.bind(this),
      )
    }

    if (!this.audioPlayer) {
      return
    }

    if (this.audioPlayer.listenerCount('idle') === 0) {
      this.audioPlayer.on(
        AudioPlayerStatus.Idle,
        this.onAudioPlayerIdle.bind(this),
      )
    }
  }

  private onVoiceConnectionDisconnect(): void {
    if (this.voiceConnection) {
      this.disconnect()
    }
  }

  private async onAudioPlayerIdle(
    _oldState: AudioPlayerState,
    newState: AudioPlayerState & { status: AudioPlayerStatus.Idle },
  ): Promise<void> {
    // Automatically advance queued song at end
    if (
      this.loopCurrentSong &&
      newState.status === AudioPlayerStatus.Idle &&
      this.status === STATUS.PLAYING
    ) {
      await this.seek(0)
      return
    }

    // Automatically re-add current song to queue
    if (
      this.loopCurrentQueue &&
      newState.status === AudioPlayerStatus.Idle &&
      this.status === STATUS.PLAYING
    ) {
      const currentSong = this.getCurrent()

      if (currentSong) {
        this.add(currentSong)
      } else {
        throw new Error('No song currently playing.')
      }
    }

    if (
      newState.status === AudioPlayerStatus.Idle &&
      this.status === STATUS.PLAYING
    ) {
      await this.forward(1)
      // Auto announce the next song if configured to
      const settings = await getGuildSettings(this.guildId)
      const { autoAnnounceNextSong } = settings
      if (autoAnnounceNextSong && this.currentChannel) {
        await this.currentChannel.send({
          embeds: this.getCurrent() ? [buildPlayingMessageEmbed(this)] : [],
        })
      }
    }
  }

  private async createReadStream(options: {
    url: string
    cacheKey: string
    ffmpegInputOptions?: string[]
    cache?: boolean
    volumeAdjustment?: string
  }): Promise<Readable> {
    return new Promise((resolve, reject) => {
      const capacitor = new WriteStream()

      if (options?.cache) {
        const cacheStream = this.fileCache.createWriteStream(
          this.getHashForCache(options.cacheKey),
        )
        capacitor
          .createReadStream()
          .pipe(
            cacheStream as WritableStream | unknown as NodeJS.WritableStream,
          )
      }

      const returnedStream = capacitor.createReadStream()
      let hasReturnedStreamClosed = false

      const stream = ffmpeg(options.url)
        .inputOptions(options?.ffmpegInputOptions ?? ['-re'])
        .noVideo()
        .audioCodec('libopus')
        .outputFormat('webm')
        .addOutputOption([
          '-filter:a',
          `volume=${options?.volumeAdjustment ?? '1'}`,
        ])
        .on('error', (error) => {
          if (!hasReturnedStreamClosed) {
            reject(error)
          }
        })
        .on('start', (command) => {
          debug(`Spawned ffmpeg with ${command}`)
        })

      stream.pipe(capacitor)

      returnedStream.on('close', () => {
        if (!options.cache) {
          stream.kill('SIGKILL')
        }

        hasReturnedStreamClosed = true
      })

      resolve(returnedStream)
    })
  }

  private createAudioStream(stream: Readable) {
    return createAudioResource(stream, {
      inputType: StreamType.WebmOpus,
      inlineVolume: true,
    })
  }

  private playAudioPlayerResource(resource: AudioResource) {
    if (this.audioPlayer !== null) {
      this.audioResource = resource
      this.setAudioPlayerVolume()
      this.audioPlayer.play(this.audioResource)
    }
  }

  private setAudioPlayerVolume(level?: number) {
    // Audio resource expects a float between 0 and 1 to represent level percentage
    this.audioResource?.volume?.setVolume((level ?? this.getVolume()) / 100)
  }
}
