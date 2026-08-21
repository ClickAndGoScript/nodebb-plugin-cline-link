'use strict';

define('admin/plugins/cline-links', ['settings', 'alerts', 'autocomplete'], function (Settings, alerts, autocomplete) {
    var ACP = {};

    function getOverrides() {
        var raw = $('#userOverrides').val();
        try {
            var parsed = JSON.parse(raw || '[]');
            return Array.isArray(parsed) ? parsed : [];
        } catch (e) {
            return [];
        }
    }

    function setOverrides(overrides) {
        $('#userOverrides').val(JSON.stringify(overrides));
    }

    function renderOverrides() {
        var overrides = getOverrides();
        var $list = $('#user-overrides-list');
        $list.empty();

        overrides.forEach(function (entry, index) {
            var $row = $('<tr></tr>');
            $row.append($('<td></td>').text(entry.username));
            $row.append(
                $('<td></td>').append(
                    $('<input type="text" class="form-control override-trackingid" />')
                        .val(entry.trackingId)
                        .attr('data-index', index)
                )
            );
            $row.append(
                $('<td></td>').append(
                    $('<button type="button" class="btn btn-danger btn-xs remove-override"><i class="fa fa-trash"></i></button>')
                        .attr('data-index', index)
                )
            );
            $list.append($row);
        });
    }

    ACP.init = function () {
        Settings.load('cline-links', $('#cline-links-settings'), function () {
            renderOverrides();
        });

        autocomplete.user($('#user-override-search'), function (ev, ui) {
            var username = ui.item.user.username;
            var overrides = getOverrides();

            if (overrides.some(function (entry) { return entry.username === username; })) {
                alerts.error('למשתמש זה כבר הוגדר Tracking ID');
            } else {
                overrides.push({ uid: ui.item.user.uid, username: username, trackingId: '' });
                setOverrides(overrides);
                renderOverrides();
            }

            $('#user-override-search').val('');
        });

        $('#user-overrides-list').on('input', '.override-trackingid', function () {
            var index = parseInt($(this).attr('data-index'), 10);
            var overrides = getOverrides();
            if (overrides[index]) {
                overrides[index].trackingId = $(this).val();
                setOverrides(overrides);
            }
        });

        $('#user-overrides-list').on('click', '.remove-override', function () {
            var index = parseInt($(this).attr('data-index'), 10);
            var overrides = getOverrides();
            overrides.splice(index, 1);
            setOverrides(overrides);
            renderOverrides();
        });

        $('#save-settings').on('click', function () {
            Settings.save('cline-links', $('#cline-links-settings'), function () {
                alerts.success('ההגדרות נשמרו בהצלחה!');
            });
        });
    };

    return ACP;
});
