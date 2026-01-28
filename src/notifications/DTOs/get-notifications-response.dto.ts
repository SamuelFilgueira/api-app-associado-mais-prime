export class GetNotificationsResponseDto {
  id: number;
  title: string;
  body: string;
  data: object;
  read: boolean;
  sentAt: Date;
  readAt: Date | null;
  deleted: boolean;

  constructor(notification: any) {
    this.id = notification.id;
    this.title = notification.title;
    this.body = notification.body;
    this.data = notification.data;
    this.read = notification.read;
    this.sentAt = notification.sentAt;
    this.readAt = notification.readAt;
    this.deleted = notification.deleted;
  }
}

export class GetNotificationsListResponseDto {
  notifications: GetNotificationsResponseDto[];
  total: number;
  unreadCount?: number;

  constructor(
    notifications: GetNotificationsResponseDto[],
    total: number,
    unreadCount?: number,
  ) {
    this.notifications = notifications;
    this.total = total;
    this.unreadCount = unreadCount;
  }
}
