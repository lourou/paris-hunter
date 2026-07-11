/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { Empty, Table, Button } from '@douyinfe/semi-ui-19';
import { IconDelete, IconEdit } from '@douyinfe/semi-icons';
import { useTranslation } from '../../services/i18n/i18n.jsx';
import { useSelector } from '../../services/state/store';

export default function NotificationAdapterTable({ notificationAdapter = [], onRemove, onEdit } = {}) {
  const t = useTranslation();
  const knownAdapter = useSelector((state) => state.notificationAdapter) || [];
  return (
    <Table
      pagination={false}
      empty={<Empty description={t('notification.tableEmptyState')} />}
      columns={[
        {
          title: t('notification.tableColumnName'),
          dataIndex: 'name',
          // Job rows created outside the UI (e.g. tools/paris-hunter/bootstrap.js)
          // persist only { id, fields } — fall back to the adapter registry so
          // the row never renders with a blank name.
          render: (name, record) => name ?? knownAdapter.find((a) => a?.id === record.id)?.name ?? record.id,
        },

        {
          title: '',
          dataIndex: 'tools',
          render: (_, record) => {
            return (
              <div style={{ float: 'right' }}>
                <Button
                  type="secondary"
                  icon={<IconEdit />}
                  onClick={() => onEdit(record.id)}
                  style={{ marginRight: '1rem' }}
                />
                <Button type="danger" icon={<IconDelete />} onClick={() => onRemove(record.id)} />
              </div>
            );
          },
        },
      ]}
      dataSource={notificationAdapter}
    />
  );
}
