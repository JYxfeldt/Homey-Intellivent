'use strict';

const Homey = require('homey');

class IntelliventApp extends Homey.App {

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('Intellivent Fresh app has been initialized');

    // Register flow cards
    this._registerFlowCards();
  }

  /**
   * Register flow cards for automation
   */
  _registerFlowCards() {
    // Trigger: Mode changed
    this.homey.flow.getDeviceTriggerCard('mode_changed');

    // Trigger: Humidity changed
    this.homey.flow.getDeviceTriggerCard('humidity_changed');

    // Condition: Mode is
    this.homey.flow.getConditionCard('mode_is')
      .registerRunListener(async (args) => {
        const currentMode = args.device.getCapabilityValue('intellivent_mode');
        return currentMode === args.mode;
      });

    // Action: Set mode
    this.homey.flow.getActionCard('set_mode')
      .registerRunListener(async (args) => {
        await args.device.setMode(args.mode);
      });

    // Action: Set RPM
    this.homey.flow.getActionCard('set_rpm')
      .registerRunListener(async (args) => {
        await args.device.setRpm(args.rpm);
      });

    // Action: Start boost
    this.homey.flow.getActionCard('start_boost')
      .registerRunListener(async (args) => {
        await args.device.startBoost(args.duration, args.rpm);
      });

    // Action: Configure humidity detection
    this.homey.flow.getActionCard('configure_humidity')
      .registerRunListener(async (args) => {
        const enabled = args.enabled === 'true';
        const sensitivity = parseInt(args.sensitivity, 10);
        await args.device.configureHumidity(enabled, sensitivity, args.rpm);
      });
  }

}

module.exports = IntelliventApp;
