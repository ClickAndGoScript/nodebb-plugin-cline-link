'use strict';

define('admin/plugins/cline-links', ['settings', 'alerts'], function (Settings, alerts) {
    var ACP = {};

    ACP.init = function () {
        Settings.load('cline-links', $('#cline-links-settings'));

        $('#save-settings').on('click', function () {
            Settings.save('cline-links', $('#cline-links-settings'), function () {
                alerts.success('ההגדרות נשמרו בהצלחה!');
            });
        });
    };

    return ACP;
});