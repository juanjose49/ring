# ring-client-api
 
[![CircleCI](https://circleci.com/gh/dgreif/ring.svg?style=svg)](https://circleci.com/gh/dgreif/ring)
[![Donate](https://img.shields.io/badge/Donate-PayPal-green.svg)](https://www.paypal.com/cgi-bin/webscr?cmd=_donations&business=HD9ZPB34FY428&currency_code=USD&source=url)
 
This is an unofficial TypeScript api for [Ring Doorbells](https://shop.ring.com/pages/doorbell-cameras),
[Ring Cameras](https://shop.ring.com/pages/security-cameras),
the [Ring Alarm System](https://shop.ring.com/pages/security-system),
[Ring Smart Lighting](https://shop.ring.com/pages/smart-lighting),
and third party devices that connect to the Ring Alarm System.
Built to support the [homebridge-ring Plugin](./homebridge)
 
## Installation

`npm i ring-client-api`


## Setup and Config
```js
import { RingApi } from 'ring-client-api'

const ringApi = new RingApi({
  // without 2fa
  email: 'some.one@website.com',
  password: 'abc123!#',
  
  // with 2fa or if you dont want to store your email/password in your config
  refreshToken: 'token generated with ring-auth-cli.  See https://github.com/dgreif/ring/wiki/Two-Factor-Auth',

  // The following are all optional. See below for details
  cameraStatusPollingSeconds: 20,
  cameraDingsPollingSeconds: 2,
  locationIds: ['488e4800-fcde-4493-969b-d1a06f683102', '4bbed7a7-06df-4f18-b3af-291c89854d60']
});
```

For accounts with 2fa enabled, see the [Two Factor Auth Wiki](https://github.com/dgreif/ring/wiki/Two-Factor-Auth)

### Optional Parameters

Option | Default | Explanation
--- | --- | ---
`refreshToken` | `undefined` | An alternate authentication method for accounts with 2fa enabled, or if you don't want to store your email/password in a config file.  See the [Two Factor Auth Wiki](https://github.com/dgreif/ring/wiki/Two-Factor-Auth).
`cameraStatusPollingSeconds` | `undefined` (No Polling) | How frequently to poll for updates to your cameras (in seconds).  Information like light/siren status do not update in real time and need to be requested periodically.
`cameraDingsPollingSeconds` | `undefined` (No Polling) | How frequently to poll for new events from your cameras (in seconds).  These include motion and doorbell presses.  Without this option, cameras will not emit any information about motion and doorbell presses.  
`locationIds` | All Locations | Allows you to limit the results to a specific set of locations. This is mainly useful for the [homebridge-ring Plugin](./homebridge), but can also be used if you only care about listening for events at a subset of your locations and don't want to create websocket connections to _all_ of your locations. This will also limit the results for `ringApi.getCameras()` to the configured locations. If this option is not included, all locations will be returned.

## Locations
```typescript
const locations = await ringApi.getLocations()
const location = locations[0]
location.hasHubs // does this location have an alarm and/or lighting bridge
location.disarm()
location.armHome([/* optional array of zids for devices to bypass */])
location.armAway([/* bypass zids */])
location.soundSiren()
location.silenceSiren()
location.cameras // array of cameras at this location
const rooms = await location.getRoomList() // array of rooms { id: number, name: string }
```

`locations` is an array of your Ring locations. Each location can be armed or disarmed,
and used to interact with all devices in that location.

## Devices
Once you have acquired the desired location, you can start
to interact with associated devices. These devices include ring alarm, ring lighting,
and third party devices connected to ring alarm
```js
import { RingDeviceType } from 'ring-client-api'

const devices = await location.getDevices()
const baseStation = devices.find(device => device.data.deviceType === RingDeviceType.BaseStation)
baseStation.setVolume(.75) // base station and keypad support volume settings between 0 and 1
console.log(baseStation.data) // object containing properties like zid, name, roomId, faulted, tamperStatus, etc.
baseStation.onData.subscribe(data => {
    // called any time data is updated for this specific device
})
```

## Cameras
You can get all cameras using `await ringApi.getCameras()` or cameras for a particular
location with `location.cameras`

```typescript
const camera = location.cameras[0]
camera.data // camera info including motion zones, light status, battery, etc.
camera.onData.subscribe(data => {
  // called every time new data is fetched for this camera
})
camera.setLight(true) // turn light on/off
camera.setSiren(true) // turn siren on/off
camera.getHealth() // fetch health info like wifi status
camera.startVideoOnDemand() // ask the camera to start a new video stream
camera.createSipSession() // creates a new SipSession which allows you to control RTP flow
camera.getHistory(50) // fetch ding history (like motion and doorbell presses)
camera.getRecording()
camera.getSnapshot() // returns a Promise<Buffer> of the latest snapshot from the camera 
```

Camera also includes the following observables:
* `onNewDing`: this will include the sip info and ding information every time a new ding is created
* `onActiveDings`: dings created within the last 65 seconds
* `onDoorbellPressed`: emits a ding every time the doorbell is pressed
* `onMotionDetected`: `true` or `false` based on `onActiveDings` containing a motion ding

Some other useful propeties
* `id`
* `name`: same as `description` from `data`
* `hasLight`: does this camera have a light
* `hasSiren`: does this camera have a siren
* `isDoorbot`: is this camera a doorbell

See the `examples` directory for additional code examples.

## Upgrading from v3 to v4

See https://github.com/dgreif/ring/wiki/Upgrading-from-v3-to-v4

## homebridge-ring

The `homebridge-ring` is also maintained in this repo.  It's readme can be found in [the `homebridge` directory](./homebridge)

## Credits

I'd like to give a big thanks to a number developers who have put a lot of hard work into analyzing the
Ring api and building similar libraries which were extremely valuable in my creation of this project.  Thank you all
for your hard work!

 * @davglass - https://github.com/davglass/doorbot - The original node project that proved we can interact with Ring's api
 * @jimhigson - https://github.com/jimhigson/ring-api - A promisified api for Ring's original line of products
 * @tchellomello - https://github.com/tchellomello/python-ring-doorbell - A python api which is widely used for Ring integrations
 * @mrose17 - https://github.com/homespun/homebridge-platform-ring-video-doorbell - The original Ring camera homebridge plugin
 * @codahq - Thanks for all your help debugging the Ring api
 * @joeyberkovitz - Great discovery work on the Ring Alarm websockets api
