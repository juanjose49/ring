import {
  ActiveDing,
  batteryCameraKinds,
  CameraData,
  CameraHealth,
  HistoricalDingGlobal,
  RingCameraModel,
  SnapshotTimestamp
} from './ring-types'
import { clientApi, RingRestClient } from './rest-client'
import { BehaviorSubject, Subject } from 'rxjs'
import {
  distinctUntilChanged,
  filter,
  map,
  publishReplay,
  refCount,
  share,
  take
} from 'rxjs/operators'
import { createSocket } from 'dgram'
import { bindToRandomPort, getPublicIp } from './rtp-utils'
import { delay, logError, logInfo } from './util'
import { SipSession, SrtpOptions } from './sip-session'
import { H264Builder } from '.'
const util = require('util')
const exec = util.promisify(require('child_process').exec)
const fs = require('fs'),
  getPort = require('get-port')

const snapshotRefreshDelay = 500,
  maxSnapshotRefreshSeconds = 30,
  maxSnapshotRefreshAttempts =
    (maxSnapshotRefreshSeconds * 1000) / snapshotRefreshDelay

function getBatteryLevel(data: CameraData) {
  const batteryLevel =
    typeof data.battery_life === 'number'
      ? data.battery_life
      : Number.parseFloat(data.battery_life)

  if (isNaN(batteryLevel)) {
    return null
  }

  return batteryLevel
}

export class RingCamera {
  id = this.initialData.id
  deviceType = this.initialData.kind
  model = RingCameraModel[this.initialData.kind] || 'Unknown Model'
  hasLight = this.initialData.led_status !== undefined
  hasSiren = this.initialData.siren_status !== undefined
  hasBattery = batteryCameraKinds.includes(this.deviceType)

  onData = new BehaviorSubject<CameraData>(this.initialData)
  onRequestUpdate = new Subject()
  onRequestActiveDings = new Subject()

  onNewDing = new Subject<ActiveDing>()
  onActiveDings = new BehaviorSubject<ActiveDing[]>([])
  onDoorbellPressed = this.onNewDing.pipe(
    filter(ding => ding.kind === 'ding'),
    share()
  )
  onMotionDetected = this.onActiveDings.pipe(
    map(dings => dings.some(ding => ding.motion || ding.kind === 'motion')),
    distinctUntilChanged(),
    publishReplay(1),
    refCount()
  )
  onBatteryLevel = this.onData.pipe(
    map(getBatteryLevel),
    distinctUntilChanged()
  )

  constructor(
    private initialData: CameraData,
    public isDoorbot: boolean,
    private restClient: RingRestClient
  ) {}

  updateData(update: CameraData) {
    this.onData.next(update)
  }

  requestUpdate() {
    this.onRequestUpdate.next()
  }

  get data() {
    return this.onData.getValue()
  }

  get name() {
    return this.data.description
  }

  get activeDings() {
    return this.onActiveDings.getValue()
  }

  get batteryLevel() {
    return getBatteryLevel(this.data)
  }

  get hasLowBattery() {
    return this.data.alerts.battery === 'low'
  }

  get isOffline() {
    return this.data.alerts.connection === 'offline'
  }

  doorbotUrl(path: string) {
    return clientApi(`doorbots/${this.id}/${path}`)
  }

  async setLight(on: boolean) {
    if (!this.hasLight) {
      return false
    }

    const state = on ? 'on' : 'off'

    await this.restClient.request({
      method: 'PUT',
      url: this.doorbotUrl('floodlight_light_' + state)
    })

    this.updateData({ ...this.data, led_status: state })

    return true
  }

  async setSiren(on: boolean) {
    if (!this.hasSiren) {
      return false
    }

    const state = on ? 'on' : 'off'

    await this.restClient.request({
      method: 'PUT',
      url: this.doorbotUrl('siren_' + state)
    })

    this.updateData({ ...this.data, siren_status: { seconds_remaining: 1 } })

    return true
  }

  async getHealth() {
    const response = await this.restClient.request<{
      device_health: CameraHealth
    }>({
      url: this.doorbotUrl('health')
    })

    return response.device_health
  }

  startVideoOnDemand() {
    return this.restClient.request({
      method: 'POST',
      url: this.doorbotUrl('vod')
    })
  }

  async getSipConnectionDetails() {
    const vodPromise = this.onNewDing
      .pipe(
        filter(x => x.kind === 'on_demand'),
        take(1)
      )
      .toPromise()
    await this.startVideoOnDemand()
    this.onRequestActiveDings.next()
    return vodPromise
  }

  processActiveDing(ding: ActiveDing) {
    const activeDings = this.activeDings

    this.onNewDing.next(ding)
    this.onActiveDings.next(activeDings.concat([ding]))

    setTimeout(() => {
      const allActiveDings = this.activeDings,
        otherDings = allActiveDings.filter(oldDing => oldDing !== ding)
      this.onActiveDings.next(otherDings)
    }, 65 * 1000) // dings last ~1 minute
  }

  getHistory(limit = 10, favoritesOnly = false) {
    const favoritesParam = favoritesOnly ? '&favorites=1' : ''
    return this.restClient.request<HistoricalDingGlobal[]>({
      url: this.doorbotUrl(`history?limit=${limit}${favoritesParam}`)
    })
  }

  async getRecording(dingIdStr: string) {
    const response = await this.restClient.request<{ url: string }>({
      url: clientApi(`dings/${dingIdStr}/share/play?disable_redirect=true`)
    })
    return response.url
  }

  private isTimestampInLifeTime(timestampAge: number) {
    return timestampAge < this.snapshotLifeTime
  }

  private async getSnapshotTimestamp() {
    const { timestamps, responseTimestamp } = await this.restClient.request<{
        timestamps: SnapshotTimestamp[]
      }>({
        url: clientApi('snapshots/timestamps'),
        method: 'POST',
        data: {
          doorbot_ids: [this.id]
        },
        json: true
      }),
      deviceTimestamp = timestamps[0],
      timestamp = deviceTimestamp ? deviceTimestamp.timestamp : 0,
      timestampAge = Math.abs(responseTimestamp - timestamp)

    this.lastSnapshotTimestampLocal = timestamp ? Date.now() - timestampAge : 0

    return {
      timestamp,
      inLifeTime: this.isTimestampInLifeTime(timestampAge)
    }
  }

  private refreshSnapshotInProgress?: Promise<boolean>
  private snapshotLifeTime = (this.hasBattery ? 600 : 30) * 1000 // battery cams only refresh timestamp every 10 minutes
  private lastSnapshotTimestampLocal = 0
  private lastSnapshotPromise?: Promise<Buffer>

  private async refreshSnapshot() {
    const currentTimestampAge = Date.now() - this.lastSnapshotTimestampLocal
    if (this.isTimestampInLifeTime(currentTimestampAge)) {
      logInfo(
        `Snapshot for ${
          this.name
        } is still within it's life time (${currentTimestampAge / 1000}s old)`
      )
      return true
    }

    for (let i = 0; i < maxSnapshotRefreshAttempts; i++) {
      const { timestamp, inLifeTime } = await this.getSnapshotTimestamp()

      if (!timestamp && this.isOffline) {
        throw new Error(
          `No snapshot available and device ${this.name} is offline`
        )
      }

      if (inLifeTime) {
        return false
      }

      await delay(snapshotRefreshDelay)
    }

    throw new Error(
      `Snapshot failed to refresh after ${maxSnapshotRefreshAttempts} attempts`
    )
  }

  async getSnapshot(allowStale = false) {
    this.refreshSnapshotInProgress =
      this.refreshSnapshotInProgress || this.refreshSnapshot()

    try {
      const useLastSnapshot = await this.refreshSnapshotInProgress

      if (useLastSnapshot && this.lastSnapshotPromise) {
        this.refreshSnapshotInProgress = undefined
        return this.lastSnapshotPromise
      }
    } catch (e) {
      logError(e.message)
      if (!allowStale) {
        throw e
      }
    }

    this.refreshSnapshotInProgress = undefined

    this.lastSnapshotPromise = this.restClient.request<Buffer>({
      url: clientApi(`snapshots/image/${this.id}`),
      responseType: 'arraybuffer'
    })

    this.lastSnapshotPromise.catch(() => {
      // snapshot request failed, don't use it again
      this.lastSnapshotPromise = undefined
    })

    return this.lastSnapshotPromise
  }

  sipUsedDingIds: string[] = []

  async getSipOptions() {
    const activeDings = this.onActiveDings.getValue(),
      existingDing = activeDings
        .slice()
        .reverse()
        .find(x => !this.sipUsedDingIds.includes(x.id_str)),
      targetDing = existingDing || (await this.getSipConnectionDetails())

    this.sipUsedDingIds.push(targetDing.id_str)

    return {
      to: targetDing.sip_to,
      from: targetDing.sip_from,
      dingId: targetDing.id_str
    }
  }

  async createSipSession(
    srtpOption: { audio?: SrtpOptions; video?: SrtpOptions } = {}
  ) {
    const videoSocket = createSocket('udp4'),
      audioSocket = createSocket('udp4'),
      [sipOptions, publicIpPromise, videoPort, audioPort] = await Promise.all([
        this.getSipOptions(),
        getPublicIp(),
        bindToRandomPort(videoSocket),
        bindToRandomPort(audioSocket)
      ]),
      rtpOptions = {
        address: await publicIpPromise,
        audio: {
          port: audioPort,
          ...srtpOption.audio
        },
        video: {
          port: videoPort,
          ...srtpOption.video
        }
      }

    return new SipSession(
      {
        ...sipOptions,
        tlsPort: await getPort() // get a random port, this can still cause race conditions.
      },
      rtpOptions,
      videoSocket,
      audioSocket
    )
  }

  /**
   * Records a live video to the file system in mp4 format.
   *
   * @param {string} filename the fully qualified path to the filename not including the
   * extension. E.g. '/Users/<username>/path/to/<filename>'.
   * @param {number} duration the duration of the video in seconds
   */
  async recordLiveVideoToFile(filename: string, duration: number = 30) {
    if (!filename) {
      throw new Error(
        'A fully qualified filename must be provided in order to record a video.'
      )
    }
    fs.existsSync(filename + '.h264') && fs.unlinkSync(filename + '.h264')
    fs.existsSync(filename + '.mp4') && fs.unlinkSync(filename + '.mp4')

    const getSipSession = () : Promise<SipSession> =>{
      return new Promise((resolve, reject) =>{
          this.createSipSession().then(resolve, reject);
          setTimeout(()=>{
              reject('Promise timed out after ' + 500 + ' ms');
          }, 500);
      });
    }
    let timeouts = 0;
    let sipSession;
    while(timeouts < 5 && !sipSession){
      try{
        sipSession = await getSipSession();
      }catch(e){
        console.log(e);
        console.log("Incrementing timeout counter and retrying.")
        timeouts++;
      }
    }
    if(!sipSession){
      throw new Error("SIP Session was not created. Exiting.")
    }

    const h264builder = new H264Builder(filename + '.h264');
    let packetReceived = false
    sipSession.videoStream.onRtpPacket.subscribe(rtpPacket => {
      packetReceived = true;
      h264builder.packetReceived(rtpPacket.message)
    })
    await sipSession.start()
    await delay(500);
    if(!packetReceived){
      sipSession.stop();
      h264builder.end();
      fs.unlinkSync(filename + '.h264');
      throw new Error("Packets were not recieved")
    }else{
      await delay((duration * 1000)-500)
    }
    
    sipSession.stop()
    h264builder.end()
    await exec(
      require('@ffmpeg-installer/ffmpeg').path +
        ' -i ' +
        filename +
        '.h264 ' +
        filename +
        '.mp4 '
    )
    fs.unlinkSync(filename + '.h264')
  }
}
