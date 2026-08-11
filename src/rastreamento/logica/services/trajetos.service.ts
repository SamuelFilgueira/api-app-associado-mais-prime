import {
	Injectable,
	InternalServerErrorException,
	Logger,
	NotFoundException,
} from '@nestjs/common';
import axios from 'axios';
import { maskSecret } from 'src/shared/log.util';
import { TrajetoResponse, TrajetoPosicao, TrajetoResumo } from '../dto/trajeto.dto';
import { TrajetoPdfLogicaService } from '../pdf/trajeto-pdf-logica.service';

const LOGICA_REQUEST_TIMEOUT = 15_000;
const LOGICA_TRAJETO_URL =
	'https://monitoramento.logicasolucoes.com.br/mobile/trajeto';

interface LogicaAuthResponse {
	erro?: boolean;
	logado?: boolean;
	token?: string;
	mensagem?: string;
}

interface LogicaListaItemPayload {
	id?: number | string;
	chassi?: string;
	[key: string]: unknown;
}

interface LogicaListaResponsePayload {
	lista?: LogicaListaItemPayload[];
	[key: string]: unknown;
}

@Injectable()
export class TrajetosService {
	private readonly logger = new Logger(TrajetosService.name);
	private readonly tokenCache = new Map<string, string>();

	constructor(private readonly pdfService: TrajetoPdfLogicaService) {}

	async obterRelatorio(params: {
		chassi: string;
		dataInicial: string;
		dataFinal: string;
		token?: string;
		baseOrigin?: string;
	}): Promise<Buffer> {
		const { chassi, dataInicial, dataFinal, token, baseOrigin } = params;
		const cacheKey = baseOrigin ?? 'default';
		const normalizedChassi = chassi?.trim();

		if (!normalizedChassi) {
			throw new NotFoundException('Chassi não informado para consulta na Lógica');
		}

		let usedToken =
			this.tokenCache.get(cacheKey) ?? token ?? process.env.LOGICA_TOKEN;

		if (!usedToken) {
			this.logger.error('LOGICA token não fornecido nem presente em env');
			throw new InternalServerErrorException(
				'LOGICA_TOKEN não definido nas variáveis de ambiente',
			);
		}

		let listaData = await this.consultarListaVeiculo(normalizedChassi, usedToken);

		if (this.isTokenInvalidResponse(listaData)) {
			this.logger.warn(
				`Token da Lógica inválido/expirado para baseOrigin=${baseOrigin ?? 'N/A'}. Tentando nova autenticação.`,
			);
			usedToken = await this.autenticar(baseOrigin);
			listaData = await this.consultarListaVeiculo(normalizedChassi, usedToken);
		}

		const parsedLista = listaData as LogicaListaResponsePayload;
		const lista = Array.isArray(parsedLista.lista) ? parsedLista.lista : [];

		const veiculoEncontrado = lista.find(
			(item) => String(item.chassi ?? '').trim() === normalizedChassi,
		);

		if (!veiculoEncontrado?.id) {
			throw new NotFoundException(
				'Veículo não encontrado na lista da API Lógica para o chassi informado',
			);
		}

		const veiculoId = Number(veiculoEncontrado.id);
		if (!Number.isFinite(veiculoId)) {
			throw new InternalServerErrorException('ID do veículo retornado pela Lógica é inválido');
		}

		const dataInicioFormatada = `${this.formatarDataIsoParaBr(dataInicial)}00:00:00`;
		const dataFimFormatada = `${this.formatarDataIsoParaBr(dataFinal)}23:59:59`;

		let trajetosData = await this.consultarTrajeto(
			veiculoId,
			dataInicioFormatada,
			dataFimFormatada,
			usedToken,
		);

		if (this.isTokenInvalidResponse(trajetosData)) {
			usedToken = await this.autenticar(baseOrigin);
			trajetosData = await this.consultarTrajeto(
				veiculoId,
				dataInicioFormatada,
				dataFimFormatada,
				usedToken,
			);
		}

		const trajetos = trajetosData as TrajetoResponse;
		const posicoes = Array.isArray(trajetos?.relatorio?.posicoes)
			? trajetos.relatorio.posicoes
			: [];
		const resumo = (trajetos?.relatorio?.resumo ?? null) as TrajetoResumo | null;

		return this.pdfService.gerarPdf({
			chassi: normalizedChassi,
			veiculoId,
			dataInicial,
			dataFinal,
			posicoes,
			resumo,
		});
	}

	private async consultarListaVeiculo(chassi: string, token: string): Promise<unknown> {
		const params = new URLSearchParams();
		params.append('chassi', chassi);
		params.append('token', token);

		const response = await axios.post(this.buildUrl('/listaVeiculo'), params, {
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			timeout: LOGICA_REQUEST_TIMEOUT,
		});

		return response.data;
	}

	private async consultarTrajeto(
		veiculoId: number,
		dataInicio: string,
		dataFim: string,
		token: string,
	): Promise<unknown> {
		const params = new URLSearchParams();
		params.append('veiculoId', String(veiculoId));
		params.append('dataInicio', dataInicio);
		params.append('dataFim', dataFim);
		params.append('token', token);

		const response = await axios.post(LOGICA_TRAJETO_URL, params, {
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			timeout: LOGICA_REQUEST_TIMEOUT,
		});

		return response.data;
	}

	private async autenticar(baseOrigin?: string): Promise<string> {
		const apiNumber = process.env.LOGICA_API_NUMBER;
		if (!apiNumber) {
			throw new InternalServerErrorException(
				'LOGICA_API_NUMBER não definido nas variáveis de ambiente',
			);
		}

		const params = new URLSearchParams();
		params.append('usuario', apiNumber);
		params.append('senha', apiNumber);

		const response = await axios.post<LogicaAuthResponse>(
			this.buildUrl('/autentica'),
			params,
			{
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				timeout: LOGICA_REQUEST_TIMEOUT,
			},
		);

		const authData = response.data;
		const refreshedToken = authData?.token;

		if (!refreshedToken || authData?.erro === true || authData?.logado === false) {
			this.logger.error(
				`Falha ao autenticar na Lógica baseOrigin=${baseOrigin ?? 'N/A'} status=${response.status} body=${JSON.stringify(authData)}`,
			);
			throw new InternalServerErrorException(
				'Falha ao autenticar na API Lógica para renovação de token',
			);
		}

		const cacheKey = baseOrigin ?? 'default';
		this.tokenCache.set(cacheKey, refreshedToken);
		this.logger.log(
			`Token da Lógica renovado com sucesso baseOrigin=${baseOrigin ?? 'N/A'} token=${maskSecret(refreshedToken)}`,
		);

		return refreshedToken;
	}

	private buildUrl(path: string): string {
		const baseUrl = process.env.LOGICA_API_BASE_URL;

		if (!baseUrl) {
			throw new InternalServerErrorException(
				'LOGICA_API_BASE_URL não definida nas variáveis de ambiente',
			);
		}

		const normalized = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
		return `${normalized}/${path.replace(/^\//, '')}`;
	}

	private isTokenInvalidResponse(data: unknown): boolean {
		if (!data || typeof data !== 'object') return false;

		const value = data as Record<string, unknown>;
		const logado = value.logado;
		const erro = value.erro;
		const mensagem =
			typeof value.mensagem === 'string' ? value.mensagem.toLowerCase() : '';

		if (logado === false || erro === true) return true;
		if (mensagem.includes('token') && (mensagem.includes('inv') || mensagem.includes('expir'))) {
			return true;
		}

		return false;
	}

	private formatarDataIsoParaBr(data: string): string {
		const iso = data?.trim();
		if (!iso) {
			throw new InternalServerErrorException('Data inválida para consulta de trajetos');
		}

		const [ano, mes, dia] = iso.split('-');
		if (!ano || !mes || !dia) {
			throw new InternalServerErrorException(
				'Data deve estar no formato YYYY-MM-DD para consulta de trajetos',
			);
		}

		return `${dia}/${mes}/${ano}`;
	}
}
