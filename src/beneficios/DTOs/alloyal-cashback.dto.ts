export class AlloyalCashbackRecordDto {
	[key: string]: unknown;
}

export class AlloyalCashbackRecordsResponseDto {
	total_amount: number;
	pending_amount: number;
	approved_amount: number;
	available_amount: number;
	in_transfer_amount: number;
	transferred_amount: number;
	title: string;
	subtitle: string;
	status: string;
	cashback_records: AlloyalCashbackRecordDto[];
}
